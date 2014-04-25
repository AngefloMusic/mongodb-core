var inherits = require('util').inherits
  , f = require('util').format
  , EventEmitter = require('events').EventEmitter
  , Pool = require('../connection/pool')
  , b = require('bson')
  , Query = require('../connection/commands').Query
  , MongoError = require('../error')
  , ReadPreference = require('./read_preference')
  , Cursor = require('../cursor')
  , CommandResult = require('./command_result')
  , getSingleProperty = require('../connection/utils').getSingleProperty
  , getProperty = require('../connection/utils').getProperty
  , BSON = require('bson').native().BSON
  , Logger = require('../connection/logger');

// All bson types
var bsonTypes = [b.Long, b.ObjectID, b.Binary, b.Code, b.DBRef, b.Symbol, b.Double, b.Timestamp, b.MaxKey, b.MinKey];

// Single store for all callbacks
var Callbacks = function() {
  EventEmitter.call(this);

  // Self reference
  var self = this;

  //
  // Flush all callbacks
  this.flush = function(err) {
    // Error out any current callbacks
    for(var id in this._events) {
      var executeError = function(_id, _callbacks) {
        process.nextTick(function() {
          _callbacks.emit(_id, err, null);
        });
      }

      executeError(id, self);
    }
  }
}

inherits(Callbacks, EventEmitter);

/**
 * @ignore
 */
var bindToCurrentDomain = function(callback) {
  var domain = process.domain;
  if(domain == null || callback == null) {
    return callback;
  } else {
    return domain.bind(callback);
  }
}

/**
 * Server implementation
 */
var Server = function(options) {
  var self = this;
  // Server callbacks
  var callbacks = new Callbacks;
  
  // Add event listener
  EventEmitter.call(this);

  // Logger
  var logger = Logger('Server', options);
  
  // Reconnect option
  var reconnect = typeof options.reconnect == 'boolean' ? options.reconnect :  true;
  var reconnectTries = options.reconnectTries || 30;
  var reconnectInterval = options.reconnectInterval || 1000;

  // Swallow or emit errors
  var emitError = typeof options.emitError == 'boolean' ? options.emitError : false;

  // Current state
  var currentReconnectRetry = reconnectTries;
  // Contains the ismaster
  var ismaster = null;
  // Contains any alternate strategies for picking
  var readPreferenceStrategies = options.readPreferenceStrategies;
  // Auth providers
  var authProviders = options.authProviders || {};

  // Let's get the bson parser if none is passed in
  if(options.bson == null) {
    options.bson = new BSON(bsonTypes);
  }

  // Save bson
  var bson = options.bson;

  // Internal connection pool
  var pool = null;

  // Name of the server
  var serverDetails = {
      host: options.host
    , port: options.port
    , name: f("%s:%s", options.host, options.port)
  }

  // Set error properties
  getProperty(this, 'name', 'name', serverDetails);

  //
  // Reconnect server
  var reconnectServer = function() {
    // Set the max retries
    currentReconnectRetry = reconnectTries;
    // Create a new Pool
    pool = new Pool(options);
    // error handler
    var errorHandler = function() {
      // Destroy the pool
      pool.destroy();
      // Adjust the number of retries
      currentReconnectRetry = currentReconnectRetry - 1;
      // No more retries
      if(currentReconnectRetry <= 0) {
        self.emit('error', f('failed to connect to %s:%s after %s retries', options.host, options.port, reconnectTries));
      } else {
        setTimeout(function() {
          reconnectServer();
        }, reconnectInterval);
      }
    }

    //
    // Attempt to connect
    pool.once('connect', function() {
      // Remove any non used handlers
      ['error', 'close', 'timeout', 'parseError'].forEach(function(e) {
        pool.removeAllListeners(e);
      })

      // Add proper handlers
      pool.on('error', errorHandler);
      pool.on('close', closeHandler);
      pool.on('timeout', timeoutHandler);
      pool.on('message', messageHandler);
      pool.on('parseError', fatalErrorHandler);

      // We need to ensure we have re-authenticated
      var keys = Object.keys(authProviders);
      if(keys.length == 0) return self.emit("reconnect", self);

      // Execute all providers
      var count = keys.length;
      // Iterate over keys
      for(var i = 0; i < keys.length; i++) {
        authProviders[keys[i]].reauthenticate(self, pool, function(err, r) {
          count = count - 1;
          // We are done, emit reconnect event
          if(count == 0) {
            return self.emit("reconnect", self);
          }
        });
      }
    });

    //
    // Handle connection failure
    pool.once('error', errorHandler);
    pool.once('close', errorHandler);
    pool.once('timeout', errorHandler);
    pool.once('parseError', errorHandler);

    // Connect pool
    pool.connect();
  }

  //
  // Handlers
  var messageHandler = function(response, connection) {
    if(logger.isDebug()) logger.debug(f('message [%s] received from %s', response.raw.toString('hex'), self.name));
    // Execute callback
    callbacks.emit(response.responseTo, null, response);      
  }

  var errorHandler = function(err, connection) {
    if(readPreferenceStrategies != null) notifyStrategies('error', [self]);
    if(logger.isInfo()) logger.info(f('server %s errored out with %s', self.name, JSON.stringify(err)));
    // Destroy all connections
    self.destroy();
    // Flush out all the callbacks
    callbacks.flush(new MongoError(f("server %s received an error %s", self.name, JSON.stringify(err))));
    // Emit error event
    if(emitError) self.emit('error', err, self);
    // If we specified the driver to reconnect perform it
    if(reconnect) setTimeout(function() { reconnectServer() }, reconnectInterval);
  }

  var fatalErrorHandler = function(err, connection) {
    if(readPreferenceStrategies != null) notifyStrategies('error', [self]);
    if(logger.isInfo()) logger.info(f('server %s errored out with %s', self.name, JSON.stringify(err)));    
    // Destroy all connections
    self.destroy();
    // Flush out all the callbacks
    callbacks.flush(new MongoError(f("server %s received an error %s", self.name, JSON.stringify(err))));
    // Emit error event
    self.emit('error', err, self);
    // If we specified the driver to reconnect perform it
    if(reconnect) setTimeout(function() { reconnectServer() }, reconnectInterval);
  }  

  var timeoutHandler = function(err, connection) {
    if(readPreferenceStrategies != null) notifyStrategies('timeout', [self]);
    if(logger.isInfo()) logger.info(f('server %s timed out', self.name));
    // Destroy all connections
    self.destroy();
    // Flush out all the callbacks
    callbacks.flush(new MongoError(f("server %s timed out", self.name)));
    // Emit error event
    self.emit('timeout', err, self);
    // If we specified the driver to reconnect perform it
    if(reconnect) setTimeout(function() { reconnectServer() }, reconnectInterval);
  }

  var closeHandler = function(err, connection) {
    if(readPreferenceStrategies != null) notifyStrategies('close', [self]);
    if(logger.isInfo()) logger.info(f('server %s closed', self.name));
    // Destroy all connections
    self.destroy();
    // Flush out all the callbacks
    callbacks.flush(new MongoError(f("server %s sockets closed", self.name)));
    // Emit error event
    self.emit('close', err, self);
    // If we specified the driver to reconnect perform it
    if(reconnect) setTimeout(function() { reconnectServer() }, reconnectInterval);
  }

  var connectHandler = function(connection) {
    // Execute an ismaster
    self.command('system.$cmd', {ismaster:true}, function(err, r) {
      if(err) return self.emit('close', err, self);

      if(!err) {
        ismaster = r.result;
      }

      if(logger.isInfo()) logger.info(f('server %s connected with ismaster [%s]', self.name, JSON.stringify(r.result)));

      // Validate if we it's a server we can connect to
      if(typeof ismaster.minWireVersion != 'number') {
        return self.emit('error', new MongoError("non supported server version"), self);
      }

      // Set the details
      if(ismaster && ismaster.me) serverDetails.name = ismaster.me;

      // Apply any applyAuthentications
      applyAuthentications(function() {
        if(readPreferenceStrategies == null) {
          return self.emit('connect', self);
        }

        // Signal connect to all readPreferences
        notifyStrategies('connect', [self], function(err, result) {
          return self.emit('connect', self);
        });
      });
    });
  }

  // Return last IsMaster document
  this.lastIsMaster = function() {
    return ismaster;
  }

  // connect
  this.connect = function() {
    // Destroy existing pool
    if(pool) {
      pool.destroy();
    }

    // Create a new connection pool
    pool = new Pool(options);
    // Add all the event handlers
    pool.on('timeout', timeoutHandler);
    pool.on('close', closeHandler);
    pool.on('error', errorHandler);
    pool.on('message', messageHandler);
    pool.on('connect', connectHandler);
    pool.on('parseError', fatalErrorHandler);
    // Connect the pool
    pool.connect(); 
  }

  // destroy the server instance
  this.destroy = function() {
    if(logger.isDebug()) logger.debug(f('destroy called on server %s', self.name));
    // Destroy all event emitters
    ["close", "message", "error", "timeout", "connect", "parseError"].forEach(function(e) {
      pool.removeAllListeners(e);
    });

    // Close pool
    pool.destroy();
  }

  // is the server connected
  this.isConnected = function() {
    if(pool) return pool.isConnected();
    return false;
  }

  //
  // Execute a write operation
  var executeWrite = function(self, type, opsField, ns, ops, options, callback) {
    if(ops.length == 0) throw new MongoError("insert must contain at least one document");
    if(typeof options == 'function') {
      callback = options;
      options = {};
    }

    // Split the ns up to get db and collection
    var p = ns.split(".");
    // Options
    var ordered = options.ordered || true;
    var writeConcern = options.writeConcern || {};
    // return skeleton
    var writeCommand = {};
    writeCommand[type] = p[1];
    writeCommand[opsField] = ops;
    writeCommand.ordered = ordered;
    writeCommand.writeConcern = writeConcern;
    
    // Execute command
    self.command(f("%s.$cmd", p[0]), writeCommand, {}, callback);    
  }

  //
  // Execute readPreference Strategies
  var notifyStrategies = function(op, params, callback) {
    if(typeof callback != 'function') {
      // Notify query start to any read Preference strategies
      for(var name in readPreferenceStrategies) {
        if(readPreferenceStrategies[name][op]) {
          var strat = readPreferenceStrategies[name];
          strat[op].apply(strat, params);
        }
      }
      // Finish up
      return;
    }

    // Execute the async callbacks
    var nPreferences = Object.keys(readPreferenceStrategies).length;
    if(nPreferences == 0) return callback(null, null);
    for(var name in readPreferenceStrategies) {
      if(readPreferenceStrategies[name][op]) {
        var strat = readPreferenceStrategies[name];
        // Add a callback to params
        var cParams = params.slice(0);
        cParams.push(function(err, r) {
          nPreferences = nPreferences - 1;
          if(nPreferences == 0) {
            callback(null, null);
          }
        })
        // Execute the readPreference
        strat[op].apply(strat, cParams);
      }
    }    
  }

  // Execute a command
  this.command = function(ns, cmd, options, callback) {
    if(typeof options == 'function') {
      callback = options;
      options = {};
    }
    
    // Ensure we have no options
    options = options || {};
    // Do we have a read Preference it need to be of type ReadPreference
    if(options.readPreference && !(options.readPreference instanceof ReadPreference)) {
      throw new Error("readPreference must be an instance of ReadPreference");
    }

    // Debug log
    if(logger.isDebug()) logger.debug(f('executing command [%s] against %s', JSON.stringify({
      ns: ns, cmd: cmd, options: options
    }), self.name));

    // If we have no connection error
    if(!pool.isConnected()) return callback(new MongoError(f("no connection available to server %s", self.name)));
    
    // Get a connection (either passed or from the pool)
    var connection = options.connection || pool.get();

    // Create a query instance
    var query = new Query(bson, ns, cmd, {
      numberToSkip: 0, numberToReturn: -1, checkKeys: false
    });

    // Set slave OK
    query.slaveOk = slaveOk(options.readPreference);

    // Bind to current domain
    callback = bindToCurrentDomain(callback);

    // Notify query start to any read Preference strategies
    if(readPreferenceStrategies != null)
      notifyStrategies('startOperation', [self, query, new Date()]);

    // Register the callback
    callbacks.once(query.requestId, function(err, result) {
      // Notify end of command
      notifyStrategies('endOperation', [self, err, result, new Date()]);
      if(err) return callback(err);
      callback(null, new CommandResult(result.documents[0], connection));
    });

    // Execute the query
    connection.write(query);
  }

  // Execute a write
  this.insert = function(ns, ops, options, callback) {
    executeWrite(this, 'insert', 'documents', ns, ops, options, callback);
  }

  // Execute a write
  this.update = function(ns, ops, options, callback) {
    executeWrite(this, 'update', 'updates', ns, ops, options, callback);
  }

  // Execute a write
  this.remove = function(ns, ops, options, callback) {
    executeWrite(this, 'delete', 'deletes', ns, ops, options, callback);
  }

  // Authentication method
  this.auth = function(mechanism, db) {
    var args = Array.prototype.slice.call(arguments, 2);
    var callback = args.pop();
    // If we don't have the mechanism fail
    if(authProviders[mechanism] == null) throw new MongoError(f("auth provider %s does not exist", mechanism));
    // Actual arguments
    var finalArguments = [self, pool, db].concat(args.slice(0)).concat([callback]);
    // Let's invoke the auth mechanism
    authProviders[mechanism].auth.apply(authProviders[mechanism], finalArguments);
  }

  // Apply all stored authentications
  var applyAuthentications = function(callback) {
    // We need to ensure we have re-authenticated
    var keys = Object.keys(authProviders);
    if(keys.length == 0) return callback(null, null);

    // Execute all providers
    var count = keys.length;
    // Iterate over keys
    for(var i = 0; i < keys.length; i++) {
      authProviders[keys[i]].reauthenticate(self, pool, function(err, r) {
        count = count - 1;
        // We are done, emit reconnect event
        if(count == 0) {
          return callback(null, null);
        }
      });
    }
  }

  //
  // Plugin methods
  //

  // Add additional picking strategy
  this.addReadPreferenceStrategy = function(name, strategy) {
    if(readPreferenceStrategies == null) readPreferenceStrategies = {};
    readPreferenceStrategies[name] = strategy;
  }

  this.addAuthProvider = function(name, provider) {
    authProviders[name] = provider;
  }

  // Match
  this.equals = function(server) {    
    if(typeof server == 'string') return server == this.name;
    return server.name == this.name;
  }

  // // Command
  // {
  //     find: ns
  //   , query: <object>
  //   , limit: <n>
  //   , fields: <object>
  //   , skip: <n>
  //   , hint: <string>
  //   , explain: <boolean>
  //   , snapshot: <boolean>
  //   , batchSize: <n>
  //   , returnKey: <boolean>
  //   , maxScan: <n>
  //   , min: <n>
  //   , max: <n>
  //   , showDiskLoc: <boolean>
  //   , comment: <string>
  // }  
  // // Options
  // {
  //     raw: <boolean>
  //   , readPreference: <ReadPreference>
  //   , maxTimeMS: <n>
  //   , tailable: <boolean>
  //   , oplogReply: <boolean>
  //   , noCursorTimeout: <boolean>
  //   , awaitdata: <boolean>
  //   , exhaust: <boolean>
  //   , partial: <boolean>
  // }

  // Create a cursor for the command
  this.cursor = function(ns, cmd, options) {
    return new Cursor(bson, ns, cmd, options, pool.get(), callbacks, options || {});
  }

  var slaveOk = function(r) {
    if(r) return r.slaveOk()
    return false;
  }
}

inherits(Server, EventEmitter);

module.exports = Server;