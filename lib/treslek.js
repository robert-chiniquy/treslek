var irc = require('irc');
var fs = require('fs');
var path = require('path');
var async = require('async');
var redis = require('redis');
var sprintf = require('sprintf').sprintf;
var _ = require('underscore');

var Sandbox = require('./sandbox').Sandbox;
var AdminSandbox = require('./sandbox').AdminSandbox;

var log = require('logmagic').local('treslek.lib.treslek');

/*
 * TreslekBot. Where the magic happens.
 * {Obj} Config object.
 */
var TreslekBot = function(conf) {
  this.conf = conf;
  this.plugins = {};
  this.adminCommands = {};
  this.registeredCommands = {};
  this.registeredHooks = {};
  this.commandUsage = {};
  this.redis = redis.createClient(this.conf.redis.port, this.conf.redis.host);
};


/*
 * Start the bot. Connect to irc, connect listeners, and load plugins.
 */
TreslekBot.prototype.start = function() {
  var that = this;

  this.irc = new irc.Client(this.conf.host, this.conf.nick, this.conf.ircOptions);

  this.irc.treslekProcessMessage = function(from, to, text, msg) {
    log.info('processing message!', {from: from, to: to});
    if (from !== that.conf.nick && that.conf.ignored.indexOf(from) === -1) {
      async.parallel({
        log: function(callback) {
          that.logMessage(from, to, text, msg);
          callback();
        },
        commands: function(callback) {
          that.executeCommands(from, to, text, msg);
          callback();
        },
        hooks: function(callback) {
          that.executeHooks(from, to, text, msg);
          callback();
        },
        adminCommands: function(callback) {
          that.executeAdminCommands(from, to, text, msg);
          callback();
        }
      });
    }
  };

  this.irc.connect(1, function() {
    log.info('Connected to irc server.', {host: that.conf.host, options: that.conf.ircOptions});
  });

  this.irc.addListener('error', function(err) {
    log.error('Error', {err: err});
  });

  this.irc.addListener('topic', function(channel, topic, nick, msg) {
    var topicStore = sprintf('%s:topic:%s', that.conf.redis.prefix, channel);
    that.redis.set(topicStore, topic);
  });

  this.irc.addListener('message#', this.irc.treslekProcessMessage);

  this.irc.addListener('pm', function(from, text, msg) {
    log.info('privmsg', {from: from});
    this.irc.treslekProcessMessage(from, from, text, msg);
  }.bind(this));

  that.sandbox = new Sandbox(that.conf, that.irc, that.redis, Object.keys(that.registeredCommands), that.commandUsage);
  that.adminSandbox = new AdminSandbox(that);

  this.loadPlugins(function(err) {
    if (err) {
      log.error('Error loading plugins', {err: err});
      return;
    }
    log.info('Loaded plugins');
  });

  this.loadAdminPlugin(function(err) {
    if (err) {
      log.error('Error loading admin plugins', {err: err});
      return;
    }
    log.info('Loaded admin plugins');
  });
};



/*
 * Execute admin commands.
 */
TreslekBot.prototype.executeAdminCommands = function(from, to, text, msg) {
  var command,
      plugin,
      commandPrefix;

  if (this.conf.admins.indexOf(from) === -1) {
    return;
  }

  commandPrefix = this.conf.commandPrefix || '!';
  if (text.indexOf(commandPrefix) !== 0) {
    return;
  }

  text = text.substring(commandPrefix.length, text.length).split(' ');
  command = text.shift();

  if (!this.adminCommands.hasOwnProperty(command)) {
    return;
  }

  plugin = new this.plugins[this.adminCommands[command]]();
  plugin[command](this.adminSandbox.bot, to, from, text.join(' '), function(err) {
    if (err) {
      log.error('error executing admin command', {err: err, command: command, from: from, text: text});
      return;
    }
    log.info('Successfully executed admin command', {command: command, from: from, text: text});
  });
};


/*
 * Given a message, see if we have any loaded plugins that register
 * a command for the message. Commands start with !.
 */
TreslekBot.prototype.executeCommands = function(from, to, text, msg) {
  var self = this,
      command,
      plugin,
      commandPrefix;

  commandPrefix = self.conf.commandPrefix || '!';
  if (text.indexOf(commandPrefix) !== 0) {
    return;
  }

  text = text.substring(commandPrefix.length, text.length).split(' ');
  command = text.shift();

  if (!this.registeredCommands.hasOwnProperty(command)) {
    return;
  }

  plugin = new this.plugins[this.registeredCommands[command]]();
  plugin[command](this.sandbox.bot, to, from, text.join(' '), function(err) {
    if (err) {
      log.error('error executing command', {command: command, from: from, text: text.join(' ')});
      return;
    }
    log.info('Successfully executed command', {command: command, from: from, text: text.join(' ')});
  });
};


/*
 * Given a message, send the message to any hooks that have been registered
 * by loaded plugins.
 */
TreslekBot.prototype.executeHooks = function(from, to, text, msg) {
  var that = this;

  async.forEach(Object.keys(this.registeredHooks), function(hook, callback) {
    var plugin = new that.plugins[that.registeredHooks[hook]]();
    plugin[hook](that.sandbox.bot, to, from, text, function(err) {
      if (err) {
        log.error('error executing hook', {hook: hook, from: from, text: text});
        callback();
        return;
      }

      log.info('successfully executed hook', {hook: hook, from: from});
      callback();
    });
  });
};

/*
 * Log a message to redis
 */
TreslekBot.prototype.logMessage = function(from, to, text, msg) {
  var that = this,
      logCount = sprintf('%s:logs:id', that.conf.redis.prefix),
      logStore = sprintf('%s:logs:%s', that.conf.redis.prefix, to);

  async.auto({
    'logId': function(callback) {
      that.redis.incr(logCount, function(err, reply) {
        if (err) {
          log.error('Error retrieving log id', {err: err});
          callback(err);
          return;
        }
        callback(null, reply);
      });
    },

    'createLog': ['logId', function(callback, results) {
      var hashKey = sprintf('%s:logs:%s', that.conf.redis.prefix, results.logId),
          logObj;

      logObj = {
        time: new Date().getTime().toString(),
        from: from,
        to: to,
        msg: text
      };

      that.redis.hmset(hashKey, logObj, function(err, reply){
        if (err) {
          log.error('Error creating log', {err: err});
          callback(err);
          return;
        }

        callback(null, results.logId);
      });
    }],

    'saveLog': ['createLog', function(callback, results) {
      async.parallel([
        function (callback) {
          that.redis.lpush(logStore, results.logId, function(err, reply) {
            if (err) {
              log.error('Error saving log', {err: err});
              callback(err);
              return;
            }

            callback();
          });
        },

        function (callback) {
          that.redis.lpush(sprintf('%s:%s', logStore, from), results.logId, function(err, reply) {
            if (err) {
              log.error('Error saving user log', {err: err});
              callback(err);
              return;
            }

            callback();
          });
        }
      ], callback);
    }]
  });
};


/*
 * Load a plugin, and register its commands and hooks.
 */
TreslekBot.prototype.loadPlugin = function(pluginFile, callback) {
  var plugin,
      pluginModule,
      usageKey,
      that = this;

  if (this.conf.enabledPlugins && this.conf.enabledPlugins.length > 0) {
    if (!_.contains(this.conf.enabledPlugins, path.basename(pluginFile))) {
      console.log('Plugin is not enabled');
      callback(new Error(path.basename(pluginFile) + ' plugin is not enabled.'));
      return;
    }
  }

  try {
    if (require.cache.hasOwnProperty(pluginFile)) {
      delete require.cache[require.resolve(pluginFile)];
    }
    pluginModule = require(pluginFile).Plugin;
    this.plugins[pluginFile] = pluginModule;

    plugin = new pluginModule();

    if (plugin.hasOwnProperty('auto')) {
      plugin.auto.forEach(function(task) {
        plugin[task](that.sandbox.bot);
      });
    }

    if (plugin.hasOwnProperty('commands')) {
      plugin.commands.forEach(function(command) {
        that.registeredCommands[command] = pluginFile;
      });
    }

    if (plugin.hasOwnProperty('hooks')) {
      plugin.hooks.forEach(function(hook) {
        that.registeredHooks[hook] = pluginFile;
      });
    }

    if (plugin.hasOwnProperty('usage')) {
      for (usageKey in plugin.usage) {
        if (plugin.usage.hasOwnProperty(usageKey)) {
          that.commandUsage[usageKey] = plugin.usage[usageKey];
        }
      }
    }
    that.sandbox.update(Object.keys(that.registeredCommands), that.commandUsage);
  } catch (err) {
    log.error('Error loading plugin', {plugin: plugin, err: err});
    callback(err);
    return;
  }

  callback();
};


/*
 * Unload a plugin and unregister all commands, hooks, and usage.
 */
TreslekBot.prototype.unloadPlugin = function(pluginFile, callback) {
  var that = this,
      plugin = new that.plugins[pluginFile](),
      usageKey;

  if (plugin.hasOwnProperty('commands')) {
    plugin.commands.forEach(function(command) {
      delete that.registeredCommands[command];
    });
  }

  if (plugin.hasOwnProperty('hooks')) {
    plugin.hooks.forEach(function(hook) {
      delete that.registeredHooks[hook];
    });
  }

  if (plugin.hasOwnProperty('usage')) {
    for (usageKey in plugin.usage) {
      if (plugin.usage.hasOwnProperty(usageKey)) {
        if (that.commandUsage.hasOwnProperty(usageKey)) {
          delete that.commandUsage[usageKey];
        }
      }
    }
  }

  delete that.plugins[pluginFile];
  delete require.cache[require.resolve(pluginFile)];

  that.sandbox.update(Object.keys(that.registeredCommands), that.commandUsage);
  callback();
};


/*
 * Reload a plugin. Unload it, and then load it again.
 */
TreslekBot.prototype.reloadPlugin = function(pluginFile, callback) {
  var that = this;

  that.unloadPlugin(pluginFile, function(err) {
    if (err) {
      log.error('Error unloading plugin', {err: err});
    }

    that.loadPlugin(pluginFile, callback);
  });
};


/*
 * Check for the plugins_dir specified in the config, and load all js
 * files located there as plugins.
 */
TreslekBot.prototype.loadPlugins = function(callback) {
  var that = this;

  fs.readdir(this.conf.plugins_dir, function(err, files) {
    if (err) {
      callback(err);
      return;
    }

    files.forEach(function(file) {
      // Only load js files
      if (file.slice(-3) === '.js') {
        that.loadPlugin(path.resolve(that.conf.plugins_dir, file.slice(0, -3)), function(err) {
          if (err) {
            log.error('Error loading plugin', {err: err});
          }
        });
      }
    });
    callback();
  });
};


/*
 * Load the plugin at lib/admin.js.
 */
TreslekBot.prototype.loadAdminPlugin = function(callback) {

  var plugin,
      pluginModule,
      pluginFile = path.resolve(__dirname, 'admin'),
      that = this;

  try {
    if (require.cache.hasOwnProperty(pluginFile)) {
      delete require.cache[pluginFile];
    }
    pluginModule = require(pluginFile).Plugin;
    this.plugins[pluginFile] = pluginModule;

    plugin = new pluginModule();

    if (plugin.hasOwnProperty('commands')) {
      plugin.commands.forEach(function(command) {
        that.adminCommands[command] = pluginFile;
      });
    }
  } catch (err) {
    log.error('Error loading plugin', {plugin: plugin, err: err});
  }

  callback();
};


exports.TreslekBot = TreslekBot;
