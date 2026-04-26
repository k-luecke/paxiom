const { RLP } = require("@ethereumjs/rlp");
const { bytesToHex } = require("ethereum-cryptography/utils");
const { hashCommitment } = require("./proof-corpus");
const { keccakProofNodeHash } = require("./goldilocks-keccak");
const {
  accountTrieKey,
  hexToBytesStrict,
  normalizeHex,
  quantityToBigInt,
  storageTrieKey,
  verifyEip1186Proof
} = require("./eth-proof");

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function hexFromBytes(bytes) {
  return normalizeHex(bytesToHex(bytes));
}

function byteLength(hex) {
  const normalized = normalizeHex(hex);
  return normalized === "0x" ? 0 : (normalized.length - 2) / 2;
}

function decodeCompactPath(bytes) {
  if (!bytes || bytes.length === 0) {
    return { kind: "empty", is_leaf: false, is_odd: false, nibbles: [] };
  }

  const first = bytes[0];
  const flag = first >> 4;
  const isLeaf = flag >= 2;
  const isOdd = (flag & 1) === 1;
  const nibbles = [];

  if (isOdd) {
    nibbles.push(first & 0x0f);
    for (const byte of bytes.slice(1)) {
      nibbles.push(byte >> 4);
      nibbles.push(byte & 0x0f);
    }
  } else {
    for (const byte of bytes.slice(1)) {
      nibbles.push(byte >> 4);
      nibbles.push(byte & 0x0f);
    }
  }

  return {
    kind: isLeaf ? "leaf" : "extension",
    is_leaf: isLeaf,
    is_odd: isOdd,
    nibbles
  };
}

function summarizeDecodedNode(decoded) {
  if (!Array.isArray(decoded)) {
    return {
      node_type: "raw",
      item_count: 0,
      child_refs: [],
      compact_path: null
    };
  }

  if (decoded.length === 17) {
    return {
      node_type: "branch",
      item_count: decoded.length,
      child_refs: decoded.slice(0, 16).map((child, index) => ({
        index,
        byte_length: child?.length || 0,
        kind: child && child.length >= 32 ? "hash" : child && child.length > 0 ? "embedded" : "empty",
        value: child && child.length > 0 ? hexFromBytes(child) : "0x"
      })),
      value_byte_length: decoded[16]?.length || 0,
      compact_path: null
    };
  }

  if (decoded.length === 2 && decoded[0] instanceof Uint8Array) {
    const compact = decodeCompactPath(decoded[0]);
    const ref = decoded[1];
    return {
      node_type: compact.kind,
      item_count: decoded.length,
      compact_path: {
        encoded: hexFromBytes(decoded[0]),
        is_leaf: compact.is_leaf,
        is_odd: compact.is_odd,
        nibble_length: compact.nibbles.length,
        nibbles_hex: compact.nibbles.map(n => n.toString(16)).join("")
      },
      child_refs: [{
        index: 0,
        byte_length: ref?.length || 0,
        kind: ref && ref.length >= 32 ? "hash" : ref && ref.length > 0 ? "embedded_or_value" : "empty",
        value: ref && ref.length > 0 ? hexFromBytes(ref) : "0x"
      }]
    };
  }

  return {
    node_type: "unknown_list",
    item_count: decoded.length,
    child_refs: [],
    compact_path: null
  };
}

function summarizeProofNode(hex, index) {
  const normalized = normalizeHex(hex);
  const bytes = hexToBytesStrict(normalized);
  const decoded = RLP.decode(bytes);
  const summary = summarizeDecodedNode(decoded);

  return {
    index,
    rlp: normalized,
    byte_length: byteLength(normalized),
    keccak: keccakProofNodeHash(normalized),
    ...summary
  };
}

function selectStorageProof(proof, slot) {
  const storageProof = proof.storageProof || [];
  assert(storageProof.length > 0, "EIP-1186 proof must include at least one storage proof");

  const wanted = normalizeHex(slot || storageProof[0].key);
  const item = storageProof.find(candidate => normalizeHex(candidate.key) === wanted);
  assert(item, `Storage proof for slot ${wanted} not found`);
  return item;
}

function stableWitnessPayload(witness) {
  const { commitment, generated_at, ...payload } = witness;
  return payload;
}

async function createEthereumInclusionWitness({ block, proof, slot }) {
  assert(block && block.stateRoot && block.hash && block.number, "Block with number, hash, and stateRoot is required");
  assert(proof && proof.address && Array.isArray(proof.accountProof), "EIP-1186 proof object is required");

  const storageItem = selectStorageProof(proof, slot);
  const verified = await verifyEip1186Proof({ block, proof });
  const accountProofNodes = proof.accountProof.map(summarizeProofNode);
  const storageProofNodes = storageItem.proof.map(summarizeProofNode);
  const accountTrieKeyHex = hexFromBytes(accountTrieKey(proof.address));
  const storageTrieKeyHex = hexFromBytes(storageTrieKey(storageItem.key));
  const verifiedStorageValue =
    verified.storage.find(item => item.key === normalizeHex(storageItem.key))?.value ||
    normalizeHex(storageItem.value);

  const witness = {
    schema: "paxiom.ethereum_inclusion_witness.v1",
    backend_status: "normalized_exact_witness",
    generated_at: new Date().toISOString(),
    chain: "ethereum",
    target: {
      block_number: quantityToBigInt(block.number).toString(),
      block_hash: normalizeHex(block.hash),
      state_root: normalizeHex(block.stateRoot),
      address: normalizeHex(proof.address),
      storage_slot: normalizeHex(storageItem.key),
      storage_value: verifiedStorageValue
    },
    public_inputs: {
      state_root: normalizeHex(block.stateRoot),
      address_hash: accountTrieKeyHex,
      storage_root: normalizeHex(proof.storageHash),
      storage_key_hash: storageTrieKeyHex,
      storage_value: verifiedStorageValue
    },
    root_checks: {
      account_root_node_hash: accountProofNodes[0]?.keccak || null,
      account_root_matches_state_root: accountProofNodes[0]?.keccak === normalizeHex(block.stateRoot),
      storage_root_node_hash: storageProofNodes[0]?.keccak || null,
      storage_root_matches_account_storage_hash: storageProofNodes[0]?.keccak === normalizeHex(proof.storageHash)
    },
    account: {
      nonce: verified.account.nonce,
      balance: verified.account.balance,
      storage_hash: verified.account.storageHash,
      code_hash: verified.account.codeHash
    },
    proof_shape: {
      account_proof_nodes: accountProofNodes.length,
      storage_proof_nodes: storageProofNodes.length,
      account_proof_bytes: accountProofNodes.reduce((sum, node) => sum + node.byte_length, 0),
      storage_proof_bytes: storageProofNodes.reduce((sum, node) => sum + node.byte_length, 0),
      max_node_bytes: Math.max(
        0,
        ...accountProofNodes.map(node => node.byte_length),
        ...storageProofNodes.map(node => node.byte_length)
      )
    },
    account_proof_nodes: accountProofNodes,
    storage_proof_nodes: storageProofNodes,
    verified_offchain: verified.verified,
    eip1186_proof_hash: verified.proofHash,
    circuit_target: {
      statement: "Prove Keccak(address), Keccak(padded storage slot), RLP node decoding, and Merkle Patricia Trie inclusion for the account and storage path inside the selected proving backend.",
      required_relations: [
        "keccak(account_proof_nodes[0].rlp) == state_root",
        "account trie path follows nibbles(keccak(address)) through branch/extension/leaf nodes",
        "decoded account storageHash == storage_root",
        "keccak(storage_proof_nodes[0].rlp) == storage_root",
        "storage trie path follows nibbles(keccak(slot32))",
        "decoded storage leaf value == storage_value"
      ]
    }
  };

  witness.commitment = hashCommitment("ETHEREUM_INCLUSION_WITNESS", stableWitnessPayload(witness));
  return witness;
}

module.exports = {
  createEthereumInclusionWitness,
  decodeCompactPath,
  stableWitnessPayload,
  summarizeProofNode
};
