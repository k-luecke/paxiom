const { bytesToHex } = require("ethereum-cryptography/utils");
const { accountTrieKey, hexToBytesStrict, leftPad32, normalizeHex, storageTrieKey } = require("./eth-proof");
const { hashCommitment } = require("./proof-corpus");
const { traceKeccak256 } = require("./keccak-trace");

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function hexFromBytes(bytes) {
  return normalizeHex(bytesToHex(bytes));
}

function makeTraceTask({ id, group, messageHex, expectedDigest, metadata }) {
  const trace = traceKeccak256(messageHex);
  const ok = trace.digest === normalizeHex(expectedDigest);
  assert(ok, `Keccak task ${id} digest mismatch`);
  return {
    id,
    group,
    metadata,
    message_hex: normalizeHex(messageHex),
    message_byte_length: trace.message_byte_length,
    expected_digest: normalizeHex(expectedDigest),
    digest: trace.digest,
    permutation_count: trace.permutations.length,
    permutations: trace.permutations
  };
}

function createExpanderKeccakBatch(witness, options = {}) {
  assert(witness && witness.schema === "paxiom.ethereum_inclusion_witness.v1", "Expected inclusion witness");

  const tasks = [];
  const address = normalizeHex(witness.target.address);
  const slot = normalizeHex(witness.target.storage_slot);
  const accountKeyMessage = hexFromBytes(hexToBytesStrict(address));
  const storageKeyMessage = hexFromBytes(leftPad32(hexToBytesStrict(slot)));

  tasks.push(makeTraceTask({
    id: "account_key",
    group: "trie_key",
    messageHex: accountKeyMessage,
    expectedDigest: hexFromBytes(accountTrieKey(address)),
    metadata: { address }
  }));

  tasks.push(makeTraceTask({
    id: "storage_key",
    group: "trie_key",
    messageHex: storageKeyMessage,
    expectedDigest: hexFromBytes(storageTrieKey(slot)),
    metadata: { slot }
  }));

  for (const node of witness.account_proof_nodes || []) {
    tasks.push(makeTraceTask({
      id: `account_node_${node.index}`,
      group: "account_proof_node",
      messageHex: node.rlp,
      expectedDigest: node.keccak,
      metadata: {
        node_index: node.index,
        node_type: node.node_type,
        byte_length: node.byte_length
      }
    }));
  }

  for (const node of witness.storage_proof_nodes || []) {
    tasks.push(makeTraceTask({
      id: `storage_node_${node.index}`,
      group: "storage_proof_node",
      messageHex: node.rlp,
      expectedDigest: node.keccak,
      metadata: {
        node_index: node.index,
        node_type: node.node_type,
        byte_length: node.byte_length
      }
    }));
  }

  const permutations = [];
  for (const task of tasks) {
    for (const permutation of task.permutations) {
      permutations.push({
        global_index: permutations.length,
        task_id: task.id,
        task_permutation_index: permutation.index,
        input_state: permutation.input_state,
        output_state: permutation.output_state
      });
    }
  }

  const batch = {
    schema: "paxiom.expander_keccak_batch.v1",
    backend_target: "expander-external-worker",
    generated_at: options.generatedAt || new Date().toISOString(),
    witness_commitment: witness.commitment || null,
    target: witness.target,
    tasks: tasks.map(task => ({
      id: task.id,
      group: task.group,
      metadata: task.metadata,
      message_hex: task.message_hex,
      message_byte_length: task.message_byte_length,
      expected_digest: task.expected_digest,
      permutation_count: task.permutation_count
    })),
    permutation_count: permutations.length,
    permutations,
    worker_contract: {
      license_boundary: "external process; Expander repository is AGPL-3.0",
      required_check: "prove every input_state -> output_state Keccak-f[1600] transition",
      output_receipt: "keccak_batch_verified"
    }
  };

  return {
    ...batch,
    commitment: hashCommitment("PAXIOM_EXPANDER_KECCAK_BATCH", {
      schema: batch.schema,
      backend_target: batch.backend_target,
      witness_commitment: batch.witness_commitment,
      target: batch.target,
      tasks: batch.tasks,
      permutation_count: batch.permutation_count,
      permutations: batch.permutations
    })
  };
}

module.exports = {
  createExpanderKeccakBatch
};
