/* Daemon (Updated) */

// Import Required Modules
var cp = require("child_process");
var http = require("http");
var events = require("events");
var async = require("async");

/**
 * The Daemon interface interacts with the coin Daemon by using the RPC interface.
 * in order to make it work it needs, as constructor, an array of objects containing
 * - "host"    : hostname where the coin lives
 * - "port"    : port where the coin accepts RPC connections
 * - "user"    : username of the coin for the RPC interface
 * - "password": password for the RPC interface of the coin
 **/

// DaemonInterface Main Function
function DaemonInterface(daemons, logger) {
	// Establish Private Daemon Variables
	var _this = this;
	logger =
		logger ||
		function (severity, message) {
			console.log(severity + ": " + message);
		};

	// Index Daemons from Parameter
	// Establish Instances
	var instances = (function () {
		for (var i = 0; i < daemons.length; i++) {
			daemons[i].index = i;
		}
		return daemons;
	})();

	// Initialize Daemons
	function initDaemons() {
		isOnline(function (online) {
			if (online) {
				_this.emit("online");
			}
		});
	}

	// Check if All Daemons are Online
	function isOnline(callback) {
		cmd("getnetworkinfo", [], function (results) {
			var allOnline = results.every(function (result) {
				return !results.error;
			});
			callback(allOnline);
			if (!allOnline) {
				_this.emit("connectionFailed", results);
			}
		});
	}

	// Configure Daemon HTTP Requests
	function requestHTTP(instance, jsonData, callback) {
		// Establish HTTP Options
		var options = {
			"hostname": typeof instance.host === "undefined" ? "127.0.0.1" : instance.host,
			"port": instance.port,
			"method": "POST",
			"auth": instance.user + ":" + instance.password,
			"headers": {
				"Content-Length": jsonData.length,
			},
		};

		// Attempt to Parse JSON from Response
		var parseJSON = function (res, data) {
			var dataJSON;
			if (res.statusCode === 401 || res.statusCode === 403) {
				logger("error", "Unauthorized RPC access - invalid RPC username or password");
				return;
			}
			try {
				dataJSON = JSON.parse(data);
			} catch (e) {
				if (data.indexOf(":-nan") !== -1) {
					data = data.replace(/:-nan,/g, ":0");
					parseJSON(res, data);
					return;
				}
				logger(
					"error",
					"Could not parse RPC data from daemon instance  " + instance.index + "\nRequest Data: " + jsonData + "\nReponse Data: " + data
				);
			}
			if (dataJSON) {
				callback(dataJSON.error, dataJSON, data);
			}
		};

		// Establish HTTP Request
		var req = http.request(options, function (res) {
			var data = "";
			res.setEncoding("utf8");
			res.on("data", function (chunk) {
				data += chunk;
			});
			res.on("end", function () {
				parseJSON(res, data);
			});
		});

		// Configure Error Behavior
		req.on("error", function (err) {
			if (err.code === "ECONNREFUSED") {
				callback(
					{
						"type": "offline",
						"message": err.message,
					},
					null
				);
			} else {
				callback(
					{
						"type": "request error",
						"message": err.message,
					},
					null
				);
			}
		});

		// Return JSON Output
		req.end(jsonData);
	}

	// Batch RPC Commands
	function batchCmd(cmdArray, callback) {
		var requestJSON = [];
		for (var i = 0; i < cmdArray.length; i++) {
			requestJSON.push({
				"method": cmdArray[i][0],
				"params": cmdArray[i][1],
				"id": Date.now() + Math.floor(Math.random() * 10) + i,
			});
		}
		var serializedRequest = JSON.stringify(requestJSON);
		requestHTTP(instances[0], serializedRequest, function (error, result) {
			callback(error, result);
		});
	}

	// Single RPC Command
	function cmd(method, params, callback, streamResults, returnRawData) {
		var results = [];
		async.each(
			instances,
			function (instance, eachCallback) {
				var itemFinished = function (error, result, data) {
					var returnObj = {
						"error": error,
						"response": (result || {}).result,
						"instance": instance,
					};
					if (returnRawData) {
						returnObj.data = data;
					}
					if (streamResults) {
						callback(returnObj);
					} else {
						results.push(returnObj);
					}
					eachCallback();
					itemFinished = function () {};
				};

				var requestJSON = JSON.stringify({
					"method": method,
					"params": params,
					"id": Date.now() + Math.floor(Math.random() * 10),
				});

				requestHTTP(instance, requestJSON, function (error, result, data) {
					itemFinished(error, result, data);
				});
			},
			function () {
				if (!streamResults) {
					callback(results);
				}
			}
		);
	}

	// Establish Public Daemon Variables
	this.init = initDaemons;
	this.isOnline = isOnline;
	this.cmd = cmd;
	this.batchCmd = batchCmd;
}

DaemonInterface.prototype.__proto__ = events.EventEmitter.prototype;
exports.interface = DaemonInterface;
