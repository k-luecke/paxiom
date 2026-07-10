// State reconstruction from archive proof data.
//
// Closes Phase 0 / A-120 / S.03 and the no-RPC architectural moat
// (paxiom-build-map R-200). Every value this module returns has been
// MPT-verified against a state root the caller can independently audit.
// Inputs may come from load.network or from Paxiom's local Erigon
// warehouse, but there is still NO fallback to an unverified RPC result:
// if a proof source cannot satisfy the request, the failure is surfaced.
//
// Pipeline (unchanged in shape from Phase 0; what changed is that step 3
// now actually verifies):
//   1. Fetch archived block bundle from load.network → block_hash, state_root.
//   2. Fetch the EIP-1186 account proof for `address` at this block.
//   3. Verify the account proof against state_root via verifier.mjs.
//   4. (Storage variant) fetch the EIP-1186 storage proof for `slot`.
//   5. Verify the storage proof against the verified storageRoot.
//   6. Return the verified envelope plus a `witness` object that holds
//      the MPT path — Service 01's ZK circuit consumes this directly
//      as witness data.
//
// On any verification failure the function throws LoadNetworkVerificationError
// with a stable `reason`. Callers must treat this as terminal; do not
// fall back to alternative data sources without an explicit operator
// decision (and a sheet update to the no-RPC architectural moat claim).

import { LoadNetworkClient } from './client.mjs';
import {
  LoadNetworkProtocolError,
  LoadNetworkDataError,
  VerificationReasons,
} from './errors.mjs';
import {
  verifyAccountProof,
  verifyStorageProof,
} from './verifier.mjs';
import { bytesToHex } from '@ethereumjs/util';

// Validate a load.network response has the fields we need; raise a
// ProtocolError (not a DataError) when the API shape itself drifts.
function ensureFields(obj, fields, where) {
  for (const f of fields) {
    if (obj?.[f] === undefined || obj?.[f] === null) {
      throw new LoadNetworkProtocolError(
        `${where}: missing required field '${f}'`,
        { field: f, stage: where },
      );
    }
  }
}

export async function reconstructAccountState({
  blockNumber,
  address,
  client = new LoadNetworkClient(),
}) {
  const block = await client.getArchivedBlock(blockNumber);
  ensureFields(block, ['block_hash', 'state_root'], 'getArchivedBlock');

  const account = await client.getAccountProof(blockNumber, address);
  ensureFields(account, ['address', 'balance', 'nonce', 'code_hash', 'storage_root', 'account_proof'], 'getAccountProof');

  if (account.address?.toLowerCase() !== address.toLowerCase()) {
    throw new LoadNetworkDataError(
      `account address mismatch: requested ${address}, got ${account.address}`,
      { stage: 'getAccountProof' },
    );
  }

  // Verify the proof. Throws LoadNetworkVerificationError on failure.
  const verified = await verifyAccountProof({
    stateRoot: block.state_root,
    address,
    account: {
      nonce:       BigInt(account.nonce),
      balance:     BigInt(account.balance),
      storageRoot: account.storage_root,
      codeHash:    account.code_hash,
    },
    accountProof: account.account_proof,
  });

  return {
    block_number: block.block_number,
    block_hash:   block.block_hash,
    state_root:   block.state_root,
    address:      account.address,
    balance:      account.balance,
    nonce:        account.nonce,
    code_hash:    account.code_hash,
    storage_root: account.storage_root,
    source:       block.source || account.source || 'load.network',
    archive_root: block.archive_root,
    verified:     true,
    // Witness shape consumed by Service 01's ZK circuit. This is the
    // canonical place downstream code reads the MPT path from; do not
    // dig into the raw response shape.
    witness: {
      account_key: bytesToHex(verified.accountKey),
      account_proof: verified.path.map((n) => bytesToHex(n)),
      state_root: block.state_root,
    },
  };
}

export async function reconstructStorageSlot({
  blockNumber,
  address,
  slot,
  client = new LoadNetworkClient(),
}) {
  const accountResult = await reconstructAccountState({ blockNumber, address, client });

  const slotResp = await client.getStorageProof(blockNumber, address, slot);
  ensureFields(slotResp, ['address', 'slot', 'value', 'storage_proof'], 'getStorageProof');

  if (slotResp.address?.toLowerCase() !== address.toLowerCase()) {
    throw new LoadNetworkDataError(
      `storage proof address mismatch: ${slotResp.address} != ${address}`,
      { stage: 'getStorageProof' },
    );
  }

  const verifiedStorage = await verifyStorageProof({
    storageRoot: accountResult.storage_root,
    slot,
    value: slotResp.value,
    storageProof: slotResp.storage_proof,
  });

  return {
    block_number: accountResult.block_number,
    block_hash:   accountResult.block_hash,
    state_root:   accountResult.state_root,
    address:      accountResult.address,
    storage_root: accountResult.storage_root,
    slot,
    value:        slotResp.value,
    source:       accountResult.source,
    archive_root: accountResult.archive_root,
    verified:     true,
    // Combined witness for the slot — both the account proof (binds
    // storageRoot to stateRoot) and the storage proof (binds value to
    // storageRoot). Service 01's ZK circuit reads both.
    witness: {
      ...accountResult.witness,
      storage_key:   bytesToHex(verifiedStorage.storageKey),
      storage_proof: verifiedStorage.path.map((n) => bytesToHex(n)),
      storage_root:  accountResult.storage_root,
    },
  };
}

// Re-export so callers can `import { LoadNetworkVerificationError, VerificationReasons }
// from './reconstruct.mjs'` without a second import.
export {
  LoadNetworkError,
  LoadNetworkNetworkError,
  LoadNetworkDataError,
  LoadNetworkVerificationError,
  LoadNetworkProtocolError,
} from './errors.mjs';
export { VerificationReasons } from './errors.mjs';
