// State reconstruction from Load Network archive data.
//
// The Phase 0 / A-120 / S.03 gate requires this pipeline to work end-to-end
// for at least one historical block. The "no-RPC" architectural moat
// (paxiom-build-map R-200) lives here: every state query is rooted in
// archived transaction data, not RPC-sourced witnesses.
//
// Pipeline:
//   1. Fetch archived block bundle from load.network.
//   2. Pull the canonical block hash and state root from the bundle.
//   3. Walk the bundle's pre-images (transactions, receipts, state-trie
//      proofs) to reconstruct any account or storage slot at that block.
//   4. Return the canonical {block_number, block_hash, state_root,
//      account_state, storage_slot} reconstruction object.
//
// Step 3 is, in real life, the work of an MPT walker. For Phase 0 we
// trust the archive bundle's `account_state` / `storage` fields directly
// (load.network is the source of truth for the substrate moat); the MPT
// proof verification is filed for follow-up to harden against corrupted
// archive responses.

import { LoadNetworkClient } from './client.mjs';

export async function reconstructAccountState({
  blockNumber,
  address,
  client = new LoadNetworkClient(),
}) {
  const block = await client.getArchivedBlock(blockNumber);
  if (!block || !block.block_hash || !block.state_root) {
    throw new Error(`load.network returned malformed block ${blockNumber}`);
  }

  const account = await client.getReconstructedState(blockNumber, address);
  if (!account || account.address?.toLowerCase() !== address.toLowerCase()) {
    throw new Error(
      `account address mismatch: requested ${address}, got ${account?.address}`,
    );
  }

  return {
    block_number: block.block_number,
    block_hash: block.block_hash,
    state_root: block.state_root,
    address: account.address,
    balance: account.balance,
    nonce: account.nonce,
    code_hash: account.code_hash,
    storage_root: account.storage_root,
    source: 'load.network',
    archive_root: block.archive_root,
  };
}

export async function reconstructStorageSlot({
  blockNumber,
  address,
  slot,
  client = new LoadNetworkClient(),
}) {
  const block = await client.getArchivedBlock(blockNumber);
  if (!block || !block.state_root) {
    throw new Error(`load.network returned malformed block ${blockNumber}`);
  }
  const slotResp = await client.getStorageSlot(blockNumber, address, slot);
  if (!slotResp || slotResp.value === undefined) {
    throw new Error(`load.network returned malformed slot for ${address}@${slot}`);
  }
  return {
    block_number: block.block_number,
    block_hash: block.block_hash,
    state_root: block.state_root,
    address,
    slot,
    value: slotResp.value,
    source: 'load.network',
    archive_root: block.archive_root,
  };
}
