/* Pool (Updated) */

// Import Required Modules
var events = require("events");
var async = require("async");
var Util = require("./util.js");

// Import Required Modules
var varDiff = require("./varDiff.js");
var Daemon = require("./daemon.js");
var Manager = require("./manager.js");
var Peer = require("./peer.js");
var Stratum = require("./stratum.js");

// Pool Main Function
var Pool = module.exports = function Pool(options, authorizeFn) {
	// Establish Pool Variables
	var _this = this;
	var lastBlockHex = "";
	var blockPollingIntervalId;
	var emitLog = function (text) {
		_this.emit("log", "debug", text);
	};
	var emitWarningLog = function (text) {
		_this.emit("log", "warning", text);
	};
	var emitErrorLog = function (text) {
		_this.emit("log", "error", text);
	};
	var emitSpecialLog = function (text) {
		_this.emit("log", "special", text);
	};

	// Check if Algorithm is Supported
	this.options = options;
	if (!(options.coin.algorithm in Algorithms)) {
		emitErrorLog("The " + options.coin.algorithm + " hashing algorithm is not supported.");
		throw new Error();
	}

	// Initialize Pool Server
	this.start = function () {
		setupVarDiff();
		setupDaemonInterface(function () {
			setupPoolData(function () {
				setupRecipients();
				setupJobManager();
				syncBlockchain(function () {
					setupFirstJob(function () {
						setupBlockPolling();
						setupPeer();
						startStratumServer(function () {
							outputPoolInfo();
							_this.emit("started");
						});
					});
				});
			});
		});
	};

	// Process Block when Found
	this.processBlockNotify = function (blockHash, sourceTrigger) {
		emitLog("Block notification via " + sourceTrigger);
		if (typeof _this.manager.currentJob !== "undefined" && blockHash !== _this.manager.currentJob.rpcData.previousblockhash) {
			getBlockTemplate(function (error, result) {
				if (error) {
					emitErrorLog("Block notify error getting block template for " + options.coin.name);
				}
			});
		}
	};

	// Configure Port Difficulty
  this.setVarDiff = function(port, varDiffConfig) {
    if (typeof(_this.varDiff[port]) != "undefined" ) {
      _this.varDiff[port].removeAllListeners();
    }
    var varDiffInstance = new varDiff(port, varDiffConfig);
    _this.varDiff[port] = varDiffInstance;
    _this.varDiff[port].on("newDifficulty", function(client, newDiff) {
	    client.enqueueNextDifficulty(newDiff);
    });
  };

  /*
  // from original node stratum pool
  this.getStratumServer = function() {
    return _this.StratumServer;
  };
	*/	

	/* from original node stratum pool

	this.attachMiners = function(miners) {
    miners.forEach(function (clientObj) {
      _this.StratumServer.manuallyAddStratumClient(clientObj);
    });
    _this.StratumServer.broadcastMiningJobs(_this.jobManager.currentJob.getJobParams());
  };

  */

  /* from original node stratum pool

  this.relinquishMiners = function(filterFn, resultCback) {
    var origStratumClients = this.StratumServer.getStratumClients();
    var stratumClients = [];
    Object.keys(origStratumClients).forEach(function (subId) {
      stratumClients.push({subId: subId, client: origStratumClients[subId]});
    });
    async.filter(
      stratumClients,
      filterFn,
      function (clientsToRelinquish) {
        clientsToRelinquish.forEach(function(cObj) {
          cObj.client.removeAllListeners();
          _this.StratumServer.removeStratumClientBySubId(cObj.subId);
        });
        process.nextTick(function () {
        resultCback(
          clientsToRelinquish.map(
            function (item) {
              return item.client;
            })
          );
        });
      }
    );
  };

	*/

	// Initialize Pool Difficulty
	function setupVarDiff() {
		_this.varDiff = {};
		Object.keys(options.ports).forEach(function (port) {
			if (options.ports[port].varDiff) {
				_this.setVarDiff(port, options.ports[port].varDiff);
			}
		});
	}

	// Initialize Pool Daemon
	function setupDaemonInterface(callback) {
		// Check to Ensure Daemons are Configured
		if (!Array.isArray(options.daemons) || options.daemons.length < 1) {
			emitErrorLog("No daemons have been configured - pool cannot start");
			return;
		}

		// Establish Daemon
		_this.daemon = new Daemon.interface(options.daemons, function (severity, message) {
			_this.emit("log", severity, message);
		});

		// Establish Online Functionality
		_this.daemon.once("online", function () {
			callback();
		});

		// Establish Failed Connection Functionality
		_this.daemon.on("connectionFailed", function (error) {
			emitErrorLog("Failed to connect daemon(s): " + JSON.stringify(error));
		});

		// Establish Error Functionality
		_this.daemon.on("error", function (message) {
			emitErrorLog(message);
		});

		// Initialize Daemon
		_this.daemon.init();
	}

	// Initialize Pool Data
	function setupPoolData(callback) {
		// Define Initial RPC Calls
		var batchRPCCommand = [
			["validateaddress", [options.addresses.address]],
			["getdifficulty", []],
			["getmininginfo", []],
			["submitblock", []],
		];

		// Check if Coin has GetInfo Defined
		if (options.coin.hasGetInfo) {
			batchRPCCommand.push(["getinfo", []]);
		} else {
			batchRPCCommand.push(["getblockchaininfo", []], ["getnetworkinfo", []]);
		}

		// Manage RPC Batches
		_this.daemon.batchCmd(batchRPCCommand, function (error, results) {
			if (error || !results) {
				emitErrorLog("Could not start pool, error with init batch RPC call: " + JSON.stringify(error));
				return;
			}

			// Check Results of Each RPC Call
			var rpcResults = {};
			for (var i = 0; i < results.length; i++) {
				var rpcCall = batchRPCCommand[i][0];
				var r = results[i];
				rpcResults[rpcCall] = r.result || r.error;

				if (rpcCall !== "submitblock" && (r.error || !r.result)) {
					emitErrorLog("Could not start pool, error with init RPC " + rpcCall + " - " + JSON.stringify(r.error));
					return;
				}
			}

			// Check Pool Address is Valid
			if (!rpcResults.validateaddress.isvalid) {
				emitErrorLog("Daemon reports address is not valid");
				return;
			}

			// Check if Mainnet/Testnet is Active
			if (options.coin.hasGetInfo) {
				options.testnet = rpcResults.getinfo.testnet === true ? true : false;
			} else {
				options.testnet = rpcResults.getblockchaininfo.chain === "test" ? true : false;
			}
			options.network = options.testnet ? options.coin.testnet : options.coin.mainnet;

			// Establish Coin Protocol Version
			options.poolAddress = rpcResults.validateaddress.address;
			options.protocolVersion = options.coin.hasGetInfo ? rpcResults.getinfo.protocolversion : rpcResults.getnetworkinfo.protocolversion;
			var difficulty = options.coin.hasGetInfo ? rpcResults.getinfo.difficulty : rpcResults.getblockchaininfo.difficulty;
			if (typeof difficulty == "object") {
				difficulty = difficulty["proof-of-work"];
			}

			// Establish Coin Initial Statistics
			options.initStats = {
				connections: options.coin.hasGetInfo ? rpcResults.getinfo.connections : rpcResults.getnetworkinfo.connections,
				difficulty: difficulty * Algorithms[options.coin.algorithm].multiplier,
				networkHashRate: rpcResults.getmininginfo.networkhashps,
			};

			// Check if Pool is Able to Submit Blocks
			if (rpcResults.submitblock.message === "Method not found") {
				options.hasSubmitMethod = false;
			} else if (rpcResults.submitblock.code === -1) {
				options.hasSubmitMethod = true;
			} else {
				emitErrorLog("Could not detect block submission RPC method, " + JSON.stringify(results));
				return;
			}

			// Send Callback
			callback();
		});
	}

	// Initialize Pool Recipients
	function setupRecipients() {
		var recipients = [];
		options.feePercent = 0;
		options.rewardRecipients = options.rewardRecipients || {};
		for (var r in options.rewardRecipients) {
			var percent = options.rewardRecipients[r];
			var rObj = {
				percent: percent / 100,
				address: r,
			};
			recipients.push(rObj);
			options.feePercent += percent;
		}
		if (recipients.length === 0) {
			emitErrorLog("No rewardRecipients have been setup which means no fees will be taken");
		}
		options.recipients = recipients;
	}

	// Check Whether Block was Accepted by Daemon
	function checkBlockAccepted(blockHash, callback) {
		_this.daemon.cmd("getblock", [blockHash], function (results) {
			var validResults = results.filter(function (result) {
				return result.response && result.response.hash === blockHash;
			});
			if (validResults.length >= 1) {
				if (validResults[0].response.confirmations >= 0) {
					callback(true, validResults[0].response.tx[0]);
				} else {
					callback(false);
				}
			} else {
				callback(false);
			}
		});
	}

	// Load Current Block Template
	function getBlockTemplate(callback) {
		// Derive Blockchain Configuration
		var callConfig = {
			capabilities: ["coinbasetxn", "workid", "coinbase/append"],
		};
		if (options.coin.segwit) {
			callConfig.rules = ["segwit"];
		}

		// Get Current Block Template
		_this.daemon.cmd(
			"getblocktemplate",
			[callConfig],
			function (result) {
				if (result.error) {
					emitErrorLog("getblocktemplate call failed for daemon instance " + result.instance.index + " with error " + JSON.stringify(result.error));
					callback(result.error);
				} else {
					var processedNewBlock = _this.manager.processTemplate(result.response);
					callback(null, result.response, processedNewBlock);
					callback = function () {};
				}
			},
			true
		);
	}

	// Submit Block to Stratum Server
	function submitBlock(blockHex, callback) {
		// Check which Submit Method is Supported
		var rpcCommand, rpcArgs;
		if (options.hasSubmitMethod) {
			rpcCommand = "submitblock";
			rpcArgs = [blockHex];
		} else {
			rpcCommand = "getblocktemplate";
			rpcArgs = [{ mode: "submit", data: blockHex }];
		}

		// Establish Submission Functionality
		_this.daemon.cmd(rpcCommand, rpcArgs, function (results) {
			for (var i = 0; i < results.length; i++) {
				var result = results[i];
				if (result.error) {
					emitErrorLog(
						"RPC error with daemon instance " +
							result.instance.index +
							" when submitting block with " +
							rpcCommand +
							" " +
							JSON.stringify(result.error)
					);
					return;
				} else if (result.response === "rejected") {
					emitErrorLog("Daemon instance " + result.instance.index + " rejected a supposedly valid block");
					return;
				}
			}
			emitLog("Submitted Block using " + rpcCommand + " successfully to daemon instance(s)");
			callback();
		});
	}

	// Initialize Pool Job Manager
	function setupJobManager() {
		// Establish Manager
		_this.manager = new Manager(options);

		// Establish Log Functionality
		_this.manager.on("log", function (severity, message) {
			_this.emit("log", severity, message);
		});

		// Establish New Block Functionality
		_this.manager.on("newBlock", function (blockTemplate) {
			if (_this.stratumServer) {
				_this.stratumServer.broadcastMiningJobs(blockTemplate.getJobParams(options));
			}
		});

		// Establish Share Functionality
		_this.manager.on("share", function (shareData, blockHex) {
			var isValidShare = !shareData.error;
			var isValidBlock = !!blockHex;
			var emitShare = function () {
				_this.emit("share", isValidShare, isValidBlock, shareData);
			};
			if (!isValidBlock) emitShare();
			else {
				if (lastBlockHex === blockHex) {
					emitWarningLog("Warning, ignored duplicate submit block " + blockHex);
				} else {
					lastBlockHex = blockHex;
				}
				submitBlock(blockHex, function () {
					checkBlockAccepted(shareData.blockHash, function (isAccepted, tx) {
						isValidBlock = isAccepted;
						shareData.txHash = tx;
						emitShare();
						getBlockTemplate(function (error, result, foundNewBlock) {
							if (foundNewBlock) emitLog("Block notification via RPC after block submission");
						});
					});
				});
			}
		});

		// Establish Updated Block Functionality
		_this.manager.on("updatedBlock", function (blockTemplate) {
			if (_this.stratumServer) {
				var job = blockTemplate.getJobParams(options);
				job[8] = false;
				_this.stratumServer.broadcastMiningJobs(job);
			}
		});
	}

	// Wait Until Blockchain is Fully Synced
	function syncBlockchain(syncedCallback) {
		// Derive Blockchain Configuration
		var callConfig = {
			capabilities: ["coinbasetxn", "workid", "coinbase/append"],
		};
		if (options.coin.segwit) {
			callConfig.rules = ["segwit"];
		}

		// Check for Blockchain to be Fully Synced
		var checkSynced = function (displayNotSynced) {
			_this.daemon.cmd("getblocktemplate", [{ capabilities: ["coinbasetxn", "workid", "coinbase/append"], rules: ["segwit"] }], function (results) {
				var synced = results.every(function (r) {
					return !r.error || r.error.code !== -10;
				});
				if (synced) {
					syncedCallback();
				} else {
					if (displayNotSynced) {
						displayNotSynced();
					}
					setTimeout(checkSynced, 5000);
					if (!process.env.forkId || process.env.forkId === "0") {
						generateProgress();
					}
				}
			});
		};

		// Check and Return Message if Not Synced
		checkSynced(function () {
			if (!process.env.forkId || process.env.forkId === "0") {
				emitErrorLog("Daemon is still syncing with network (download blockchain) - server will be started once synced");
			}
		});

		// Calculate Current Progress on Sync
		var generateProgress = function () {
			var cmd = options.coin.hasGetInfo ? "getinfo" : "getblockchaininfo";
			_this.daemon.cmd(cmd, [], function (results) {
				var blockCount = results.sort(function (a, b) {
					return b.response.blocks - a.response.blocks;
				})[0].response.blocks;

				// Compare with Peers to Get Percentage Synced
				_this.daemon.cmd("getpeerinfo", [], function (results) {
					var peers = results[0].response;
					var totalBlocks = peers.sort(function (a, b) {
						return b.startingheight - a.startingheight;
					})[0].startingheight;
					var percent = ((blockCount / totalBlocks) * 100).toFixed(2);
					emitWarningLog("Downloaded " + percent + "% of blockchain from " + peers.length + " peers");
				});
			});
		};
	}

	// Initialize Pool First Job
	function setupFirstJob(callback) {
		// Establish First Block Template
		getBlockTemplate(function (error, result) {
			if (error) {
				emitErrorLog("Error with getblocktemplate on creating first job, server cannot start");
				return;
			}

			// Check for Difficulty/Warnings
			var portWarnings = [];
			var networkDiffAdjusted = options.initStats.difficulty;
			Object.keys(options.ports).forEach(function (port) {
				var portDiff = options.ports[port].diff;
				if (networkDiffAdjusted < portDiff) portWarnings.push("port " + port + " w/ diff " + portDiff);
			});
			if (portWarnings.length > 0 && (!process.env.forkId || process.env.forkId === "0")) {
				var warnMessage = "Network diff of " + networkDiffAdjusted + " is lower than " + portWarnings.join(" and ");
				emitWarningLog(warnMessage);
			}

			// Send Callback
			callback();
		});
	}

	// Initialize Pool Block Polling
	function setupBlockPolling() {
		if (typeof options.blockRefreshInterval !== "number" || options.blockRefreshInterval <= 0) {
			emitLog("Block template polling has been disabled");
			return;
		}
		var pollingFlag = false;
		var pollingInterval = options.blockRefreshInterval;
		blockPollingIntervalId = setInterval(function () {
			if (pollingFlag === false) {
				pollingFlag = true;
				getBlockTemplate(function (error, result, foundNewBlock) {
					if (foundNewBlock) {
						emitLog("Block notification via RPC polling");
					}
					pollingFlag = false;
				});
			}
		}, pollingInterval);
	}

	// Initialize Pool Peers
	function setupPeer() {
		// Check for P2P Configuration
		if (!options.p2p || !options.p2p.enabled) return;
		if (options.testnet && !options.coin.peerMagicTestnet) {
			emitErrorLog("p2p cannot be enabled in testnet without peerMagicTestnet set in coin configuration");
			return;
		} else if (!options.coin.peerMagic) {
			emitErrorLog("p2p cannot be enabled without peerMagic set in coin configuration");
			return;
		}

		// Establish Peer
		_this.peer = new Peer(options);

		// Establish Connection Functionality
		_this.peer.on("connected", function () {});
		_this.peer.on("disconnected", function () {});

		// Establish Rejected Connection Functionality
		_this.peer.on("connectionRejected", function () {
			emitErrorLog("p2p connection failed - likely incorrect p2p magic value");
		});

		// Establish Failed Connection Functionality
		_this.peer.on("connectionFailed", function (err) {
			emitErrorLog("p2p connection failed - likely incorrect host or port");
		});

		// Establish Socket Error Functionality
		_this.peer.on("socketError", function (err) {
			emitErrorLog("p2p had a socket error " + JSON.stringify(err));
		});

		// Establish Error Functionality
		_this.peer.on("error", function (msg) {
			emitWarningLog("p2p had an error " + msg);
		});

		// Establish Found Block Functionality
		_this.peer.on("blockFound", function (hash) {
			_this.processBlockNotify(hash, "p2p");
		});
	}

	// Start Pool Stratum Server
	function startStratumServer(callback) {
		// Establish Stratum Server
		_this.stratumServer = new Stratum.server(options, authorizeFn);

		// Establish Started Functionality
		_this.stratumServer.on("started", function () {
			var stratumPorts = Object.keys(options.ports);
			stratumPorts = stratumPorts.filter(function (port) {
				return options.ports[port].enabled === true;
			});
			options.initStats.stratumPorts = stratumPorts;
			_this.stratumServer.broadcastMiningJobs(_this.manager.currentJob.getJobParams(options));
			callback();
		});

		// Establish Timeout Functionality
		_this.stratumServer.on("broadcastTimeout", function () {
			if (options.debug) {
				emitLog("No new blocks for " + options.jobRebroadcastTimeout + " seconds - updating transactions & rebroadcasting work");
			}
			_this.daemon.cmd("getblocktemplate", [], function () {});
			getBlockTemplate(function (error, rpcData, processedBlock) {
				if (error || processedBlock) return;
				_this.manager.updateCurrentJob(rpcData);
			});
		});

		// Establish New Connection Functionality
		_this.stratumServer.on("client.connected", function (client) {
			// Manage/Record Client Difficulty
			if (typeof _this.varDiff[client.socket.localPort] !== "undefined") {
				_this.varDiff[client.socket.localPort].manageClient(client);
			}

			// Establish Client Difficulty Functionality
			client.on("difficultyChanged", function (diff) {
				_this.emit("difficultyUpdate", client.workerName, diff);
			});

			// Establish Client Subscription Functionality
			client.on("subscription", function (params, resultCallback) {
				switch (options.coin.algorithm) {
					// Equihash Subscription Handling
					case "equihash":
						var extraNonce = _this.manager.extraNonceCounter.next();
						resultCallback(null, extraNonce, extraNonce);
						if (typeof options.ports[client.socket.localPort] !== "undefined" && options.ports[client.socket.localPort].diff) {
							this.sendDifficulty(options.ports[client.socket.localPort].diff);
						} else {
							this.sendDifficulty(8);
						}
						this.sendMiningJob(_this.manager.currentJob.getJobParams(options));

					// Default Subscription Handling
					default:
						var extraNonce = _this.manager.extraNonceCounter.next();
						var extraNonce2Size = _this.manager.extraNonce2Size;
						resultCallback(null, extraNonce, extraNonce2Size);
						if (typeof options.ports[client.socket.localPort] !== "undefined" && options.ports[client.socket.localPort].diff) {
							this.sendDifficulty(options.ports[client.socket.localPort].diff);
						} else {
							this.sendDifficulty(8);
						}
						this.sendMiningJob(_this.manager.currentJob.getJobParams(options));
				}
			});

			// Establish Client Submission Functionality
			client.on("submit", function (message, resultCallback) {
				switch (options.coin.algorithm) {
					// Equihash Share Handling
					case "equihash":
						var result = _this.manager.processShare(
							message.params[1],
							client.previousDifficulty,
							client.difficulty,
							client.extraNonce1,
							message.params[3],
							message.params[2],
							client.extraNonce1 + message.params[3],
							client.remoteAddress,
							client.socket.localPort,
							message.params[0],
							message.params[4]
						);
						resultCallback(result.error, result.result ? true : null);

					// Default Share Handling
					default:
						var result = _this.manager.processShare(
							message.params[1],
							client.previousDifficulty,
							client.difficulty,
							client.extraNonce1,
							message.params[2],
							message.params[3],
							message.params[4],
							client.remoteAddress,
							client.socket.localPort,
							message.params[0],
							null
						);
						resultCallback(result.error, result.result ? true : null);
				}
			});

			// Establish Client Error Messaging Functionality
			client.on("malformedMessage", function (message) {});

			// Establish Client Socket Error Functionality
			client.on("socketError", function (e) {
				emitWarningLog("Socket error from " + client.getLabel() + ": " + JSON.stringify(e));
			});

			// Establish Client Socket Timeout Functionality
			client.on("socketTimeout", function (reason) {
				emitWarningLog("Connected timed out for " + client.getLabel() + ": " + reason);
			});

			// Establish Client Disconnect Functionality
			client.on("socketDisconnect", function () {});

			// Establish Client Banned Functionality
			client.on("kickedBannedIP", function (remainingBanTime) {
				emitLog("Rejected incoming connection from " + client.remoteAddress + " banned for " + remainingBanTime + " more seconds");
			});

			// Establish Client Forgiveness Functionality
			client.on("forgaveBannedIP", function () {
				emitLog("Forgave banned IP " + client.remoteAddress);
			});

			// Establish Client Unknown Stratum Functionality
			client.on("unknownStratumMethod", function (fullMessage) {
				emitLog("Unknown stratum method from " + client.getLabel() + ": " + fullMessage.method);
			});

			// Establish Client DDOS Functionality
			client.on("socketFlooded", function () {
				emitWarningLog("Detected socket flooding from " + client.getLabel());
			});

			// Establish Client TCP Error Functionality
			client.on("tcpProxyError", function (data) {
				emitErrorLog("Client IP detection failed, tcpProxyProtocol is enabled yet did not receive proxy protocol message, instead got data: " + data);
			});

			// Establish Client Banning Functionality
			client.on("triggerBan", function (reason) {
				emitWarningLog("Banned triggered for " + client.getLabel() + ": " + reason);
				_this.emit("banIP", client.remoteAddress, client.workerName);
			});
		});
	}

	// Output Derived Pool Information
	function outputPoolInfo() {
		var startMessage =
			"Stratum Pool Server Started for " + options.coin.name + " [" + options.coin.symbol.toUpperCase() + "] {" + options.coin.algorithm + "}";
		if (process.env.forkId && process.env.forkId !== "0") {
			emitLog(startMessage);
			return;
		}
		var infoLines = [
			startMessage,
			"Network Connected:\t" + (options.testnet ? "Testnet" : "Mainnet"),
			"Current Block Height:\t" + _this.manager.currentJob.rpcData.height,
			"Current Connect Peers:\t" + options.initStats.connections,
			"Current Block Diff:\t" + _this.manager.currentJob.difficulty * Algorithms[options.coin.algorithm].multiplier,
			"Network Difficulty:\t" + options.initStats.difficulty,
			"Stratum Port(s):\t" + _this.options.initStats.stratumPorts.join(", "),
			"Pool Fee Percent:\t" + _this.options.feePercent + "%",
		];
		if (typeof options.blockRefreshInterval === "number" && options.blockRefreshInterval > 0) {
			infoLines.push("Block Polling Every:\t" + options.blockRefreshInterval + " ms");
		}
		emitSpecialLog(infoLines.join("\n\t\t\t\t\t\t"));
	}
};

//module.exports = Pool;
Pool.prototype.__proto__ = events.EventEmitter.prototype;
