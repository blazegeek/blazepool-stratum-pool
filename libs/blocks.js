/* Blocks (Updated) */

// Import Required Modules
var bignum = require("bignum");
var Util = require("./util.js");

// Import Required Modules
var Merkle = require("./merkle.js");
var Transactions = require("./transactions.js");

// BlockTemplate Main Function
var BlockTemplate = module.exports = function BlockTemplate(jobId, rpcData, extraNoncePlaceholder, options) {
	// Current Block Headers Seen
	var submits = [];

	// Establish Block Variables
	this.rpcData = rpcData;
	this.jobId = jobId;

	// Calculate Block Target/Difficulty
	this.target = rpcData.target ? bignum(rpcData.target, 16) : Util.bignumFromBitsHex(rpcData.bits);
	this.difficulty = parseFloat((diff1 / this.target.toNumber()).toFixed(9));

	// Function to get Merkle Hashes
	function getMerkleHashes(steps) {
		return steps.map(function (step) {
			return step.toString("hex");
		});
	}

	// Function to get Transaction Buffers
	function getTransactionBuffers(txs) {
		var txHashes = txs.map(function (tx) {
			if (tx.txid !== undefined) {
				return Util.uint256BufferFromHash(tx.txid);
			}
			return Util.uint256BufferFromHash(tx.hash);
		});
		return [null].concat(txHashes);
	}

	// Function to get Masternode Vote Data
	function getVoteData() {
		if (!rpcData.masternode_payments) {
			return Buffer.from([]);
		}
		return Buffer.concat(
			[Util.varIntBuffer(rpcData.votes.length)].concat(
				rpcData.votes.map(function (vt) {
					return Buffer.from(vt, "hex");
				})
			)
		);
	}

	// Create Generation Transaction
	function createGeneration(rpcData, extraNoncePlaceholder, options) {
		var transactions = new Transactions();
		switch (options.coin.algorithm) {
			// Equihash Genesis Transaction
			case "equihash":
				return transactions.zcash(rpcData, options);

			// Default Genesis Transaction
			default:
				return transactions.bitcoin(rpcData, extraNoncePlaceholder, options);
		}
	}

	// Create Merkle Data
	function createMerkle(rpcData, genTransaction, options) {
		switch (options.coin.algorithm) {
			// Equihash Merkle Creation
			case "equihash":
				return new Merkle(null).getRoot(rpcData, genTransaction[1]);

			// Default Merkle Creation
			default:
				return new Merkle(getTransactionBuffers(rpcData.transactions));
		}
	}

	// Establish Generation/Merkle
	this.generation = createGeneration(this.rpcData, extraNoncePlaceholder, options);
	this.merkle = createMerkle(this.rpcData, this.generation, options);

	// Structure Block Transaction Data
	this.transactions = Buffer.concat(
		rpcData.transactions.map(function (tx) {
			return Buffer.from(tx.data, "hex");
		})
	);

	// Structure Block Historical Hashes
	this.prevHashReversed = Util.reverseByteOrder(Buffer.from(rpcData.previousblockhash, "hex")).toString("hex");
	if (rpcData.finalsaplingroothash) {
		this.hashReserved = Util.reverseBuffer(new Buffer(rpcData.finalsaplingroothash, "hex")).toString("hex");
	} else {
		this.hashReserved = "0000000000000000000000000000000000000000000000000000000000000000";
	}

	// Push Submissions to Array
	this.registerSubmit = function (header) {
		var submission = header.join("").toLowerCase();
		if (submits.indexOf(submission) === -1) {
			submits.push(submission);
			return true;
		}
		return false;
	};

	// Serialize Block Coinbase
	this.serializeCoinbase = function (extraNonce1, extraNonce2, options) {
		switch (options.coin.algorithm) {
			// Default Coinbase Serialization
			default:
				return Buffer.concat([this.generation[0][0], extraNonce1, extraNonce2, this.generation[0][1]]);
		}
	};

	// Serialize Block Headers
	this.serializeHeader = function (merkleRoot, nTime, nonce, options) {
		switch (options.coin.algorithm) {
			// Equihash Header Serialization
			case "equihash":
				var header = Buffer.alloc(140);
				var position = 0;
				var merkleRootReversed = Util.reverseBuffer(Buffer.from(merkleRoot, "hex")).toString("hex");
				var bitsReversed = Util.reverseBuffer(Buffer.from(this.rpcData.bits, "hex")).toString("hex");
				header.writeUInt32LE(this.rpcData.version, (position += 0), 4, "hex");
				header.write(this.prevHashReversed, (position += 4), 32, "hex");
				header.write(merkleRootReversed, (position += 32), 32, "hex");
				header.write(nTime, (position += 32), 4, "hex");
				header.write(bitsReversed, (position += 4), 4, "hex");
				header.write(nonce, (position += 4), 32, "hex");
				return header;

			// Default Header Serialization
			default:
				var header = Buffer.alloc(80);
				var position = 0;
				header.write(nonce, position, 4, "hex");
				header.write(this.rpcData.bits, (position += 4), 4, "hex");
				header.write(nTime, (position += 4), 4, "hex");
				header.write(merkleRoot, (position += 4), 32, "hex");
				header.write(this.rpcData.previousblockhash, (position += 32), 32, "hex");
				header.writeUInt32BE(this.rpcData.version, position + 32);
				var header = Util.reverseBuffer(header);
				return header;
		}
	};

	// Serialize Entire Block
	this.serializeBlock = function (header, secondary, options) {
		switch (options.coin.algorithm) {
			// Equihash Block Serialization
			case "equihash":
				var txCount = this.rpcData.transactions.length + 1;
				if (Math.abs(txCount.length % 2) == 1) {
					txCount = "0" + txCount;
				}
				if (this.txCount <= 0xfc) {
					var varInt = Buffer.from(txCount, "hex");
				} else if (this.txCount <= 0x7fff) {
					if (txCount.length == 2) {
						txCount = "00" + txCount;
					}
					var varInt = Buffer.concat([Buffer.from("FD", "hex"), Util.reverseBuffer(Buffer.from(txCount, "hex"))]);
				}
				var buffer = Buffer.concat([header, soln, varInt, Buffer.from(this.generation[1], "hex"), this.transactions]);
				return buffer;

			// Default Block Serialization
			default:
				var buffer = Buffer.concat([
					header,
					Util.varIntBuffer(this.rpcData.transactions.length + 1),
					secondary,
					this.transactions,
					getVoteData(),
					Buffer.from([]),
				]);
				return buffer;
		}
	};

	// Get Current Job Parameters
	this.getJobParams = function (options) {
		switch (options.coin.algorithm) {
			// Equihash Job Parameters
			case "equihash":
				if (!this.jobParams) {
					this.jobParams = [
						this.jobId,
						Util.packUInt32LE(this.rpcData.version).toString("hex"),
						this.prevHashReversed,
						Util.reverseBuffer(new Buffer(this.merkle, "hex")).toString("hex"),
						this.hashReserved,
						Util.packUInt32LE(this.rpcData.curtime).toString("hex"),
						Util.reverseBuffer(new Buffer(this.rpcData.bits, "hex")).toString("hex"),
						true,
					];
				}
				return this.jobParams;

			// Default Job Parameters
			default:
				if (!this.jobParams) {
					this.jobParams = [
						this.jobId,
						this.prevHashReversed,
						this.generation[0][0].toString("hex"),
						this.generation[0][1].toString("hex"),
						getMerkleHashes(this.merkle.steps),
						Util.packInt32BE(this.rpcData.version).toString("hex"),
						this.rpcData.bits,
						Util.packUInt32BE(this.rpcData.curtime).toString("hex"),
						true,
					];
				}
				return this.jobParams;
		}
	};
};

// Export BlockTemplate
//module.exports = BlockTemplate;
