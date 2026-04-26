const { RLP } = require("@ethereumjs/rlp");
const { Trie } = require("@ethereumjs/trie");
const { keccak256 } = require("ethereum-cryptography/keccak");
const { bytesToHex, hexToBytes } = require("ethereum-cryptography/utils");
const { hashCommitment } = require("./proof-corpus");

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function normalizeHex(value) {
  if (typeof value !== "string") {
    throw new Error("Expected hex string");
  }
  if (value === "0x") return "0x";
  const body = value.startsWith("0x") ? value.slice(2) : value;
  return `0x${body.toLowerCase()}`;
}

function hexToBytesStrict(value) {
  const hex = normalizeHex(value);
  if (hex === "0x") return new Uint8Array();
  return hexToBytes(hex.length % 2 === 0 ? hex : `0x0${hex.slice(2)}`);
}

function bytesToQuantity(bytes) {
  if (!bytes || bytes.length === 0) return 0n;
  return BigInt(`0x${bytesToHex(bytes)}`);
}

function quantityToBigInt(value) {
  if (typeof value === "bigint") return value;
  if (typeof value === "number") return BigInt(value);
  if (typeof value === "string") {
    if (value.startsWith("0x")) return BigInt(value);
    return BigInt(value);
  }
  throw new Error("Invalid quantity");
}

function leftPad32(bytes) {
  assert(bytes.length <= 32, "Storage key is wider than 32 bytes");
  const out = new Uint8Array(32);
  out.set(bytes, 32 - bytes.length);
  return out;
}

function proofNodes(proof) {
  assert(Array.isArray(proof), "Proof must be an array");
  return proof.map(hexToBytesStrict);
}

function accountTrieKey(address) {
  const addr = hexToBytesStrict(address);
  assert(addr.length === 20, "Address must be 20 bytes");
  return keccak256(addr);
}

function storageTrieKey(slot) {
  return keccak256(leftPad32(hexToBytesStrict(slot)));
}

function decodeAccount(value) {
  assert(value && value.length > 0, "Account proof resolved to empty account");
  const decoded = RLP.decode(value);
  assert(Array.isArray(decoded) && decoded.length === 4, "Invalid account RLP");

  return {
    nonce: bytesToQuantity(decoded[0]).toString(),
    balance: bytesToQuantity(decoded[1]).toString(),
    storageHash: normalizeHex(bytesToHex(decoded[2])),
    codeHash: normalizeHex(bytesToHex(decoded[3]))
  };
}

async function verifyAccountProof(stateRoot, proof) {
  assert(proof && typeof proof === "object", "EIP-1186 proof object is required");
  const trie = new Trie();
  const value = await trie.verifyProof(
    hexToBytesStrict(stateRoot),
    accountTrieKey(proof.address),
    proofNodes(proof.accountProof)
  );
  const account = decodeAccount(value);

  assert(BigInt(account.nonce) === quantityToBigInt(proof.nonce), "Account nonce mismatch");
  assert(BigInt(account.balance) === quantityToBigInt(proof.balance), "Account balance mismatch");
  assert(account.storageHash === normalizeHex(proof.storageHash), "Account storageHash mismatch");
  assert(account.codeHash === normalizeHex(proof.codeHash), "Account codeHash mismatch");

  return account;
}

async function verifyStorageProof(storageHash, item) {
  assert(item && typeof item === "object", "Storage proof item is required");
  const trie = new Trie();
  const value = await trie.verifyProof(
    hexToBytesStrict(storageHash),
    storageTrieKey(item.key),
    proofNodes(item.proof)
  );
  const provenValue = value === null ? 0n : bytesToQuantity(RLP.decode(value));
  const expectedValue = quantityToBigInt(item.value);

  assert(provenValue === expectedValue, `Storage value mismatch for key ${item.key}`);
  return {
    key: normalizeHex(item.key),
    value: `0x${expectedValue.toString(16)}`
  };
}

async function verifyEip1186Proof({ block, proof }) {
  assert(block && block.stateRoot, "Block with stateRoot is required");
  const account = await verifyAccountProof(block.stateRoot, proof);
  const storage = [];

  for (const item of proof.storageProof || []) {
    storage.push(await verifyStorageProof(account.storageHash, item));
  }

  return {
    verified: true,
    blockNumber: quantityToBigInt(block.number).toString(),
    blockHash: normalizeHex(block.hash),
    stateRoot: normalizeHex(block.stateRoot),
    address: normalizeHex(proof.address),
    account,
    storage,
    proofHash: hashCommitment("EIP1186_PROOF", {
      blockHash: normalizeHex(block.hash),
      stateRoot: normalizeHex(block.stateRoot),
      address: normalizeHex(proof.address),
      accountProof: proof.accountProof,
      storageProof: proof.storageProof || []
    })
  };
}

module.exports = {
  accountTrieKey,
  normalizeHex,
  quantityToBigInt,
  storageTrieKey,
  verifyAccountProof,
  verifyEip1186Proof,
  verifyStorageProof
};
