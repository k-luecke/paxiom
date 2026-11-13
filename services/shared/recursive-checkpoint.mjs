const HEX32 = /^0x[0-9a-f]{64}$/;
const FORK_VERSION = /^0x[0-9a-f]{8}$/;
const AO_ID = /^[A-Za-z0-9_-]{43}$/;
const DECIMAL = /^(0|[1-9][0-9]*)$/;

export const RECURSIVE_CHECKPOINT_KIND = 'paxiom-sp1-recursive-checkpoint';

export function validateCheckpointConfig(config) {
  requireObject(config, 'config');
  requireAoId(config.verifierAuthority, 'verifierAuthority');
  requireHex32(config.updateVkey, 'updateVkey');
  requireHex32(config.accumulatorVkey, 'accumulatorVkey');
  requireHex32(config.syncCommitteeRoot, 'syncCommitteeRoot');
  requireHex32(config.genesisValidatorsRoot, 'genesisValidatorsRoot');
  requireForkVersion(config.forkVersion);
  return Object.freeze({
    verifierAuthority: config.verifierAuthority,
    updateVkey: config.updateVkey,
    accumulatorVkey: config.accumulatorVkey,
    syncCommitteeRoot: config.syncCommitteeRoot,
    genesisValidatorsRoot: config.genesisValidatorsRoot,
    forkVersion: config.forkVersion,
  });
}

export function createCheckpointState(config) {
  return {
    config: validateCheckpointConfig(config),
    latestCommitId: null,
    latest: null,
    count: 0,
    byCommitId: new Map(),
  };
}

/**
 * Models the checks made by ao-processes/recursive-checkpoint.lua.
 * `from` and `commitId` are authenticated AO message metadata, not JSON fields.
 * This function does not verify an SP1 proof; only the configured verifier may
 * attest that it performed that verification before submitting a checkpoint.
 */
export function commitCheckpoint(state, { from, commitId, checkpoint }) {
  requireObject(state, 'state');
  const config = validateCheckpointConfig(state.config);
  if (from !== config.verifierAuthority) {
    throw new Error('unauthorized verifier authority');
  }
  requireAoId(commitId, 'commitId');
  if (state.byCommitId.has(commitId)) {
    throw new Error('duplicate AO commit id');
  }

  const next = validateCheckpoint(checkpoint, config);
  if (next.previousCommitId !== state.latestCommitId) {
    throw new Error('previous AO commit id does not match the registry head');
  }

  if (state.latest) {
    const prior = state.latest;
    if (asBigInt(next.updateCount, 'updateCount') <= asBigInt(prior.updateCount, 'prior updateCount')) {
      throw new Error('updateCount must increase');
    }
    if (asBigInt(next.endSlot, 'endSlot') <= asBigInt(prior.endSlot, 'prior endSlot')) {
      throw new Error('endSlot must increase');
    }
    if (next.startSlot !== prior.startSlot || next.startBeaconRoot !== prior.startBeaconRoot) {
      throw new Error('checkpoint start anchor changed');
    }
  }

  const stored = Object.freeze({ ...next, commitId });
  state.latestCommitId = commitId;
  state.latest = stored;
  state.count += 1;
  state.byCommitId.set(commitId, stored);
  return stored;
}

export function validateCheckpoint(checkpoint, configInput) {
  requireObject(checkpoint, 'checkpoint');
  const config = validateCheckpointConfig(configInput);
  if (checkpoint.kind !== RECURSIVE_CHECKPOINT_KIND) {
    throw new Error(`kind must be ${RECURSIVE_CHECKPOINT_KIND}`);
  }
  if (checkpoint.version !== 1) throw new Error('version must be 1');

  requireDecimal(checkpoint.startSlot, 'startSlot');
  requireDecimal(checkpoint.endSlot, 'endSlot');
  requireDecimal(checkpoint.updateCount, 'updateCount');
  if (asBigInt(checkpoint.startSlot, 'startSlot') >= asBigInt(checkpoint.endSlot, 'endSlot')) {
    throw new Error('endSlot must be greater than startSlot');
  }
  if (asBigInt(checkpoint.updateCount, 'updateCount') < 2n) {
    throw new Error('recursive checkpoint must contain at least two updates');
  }

  for (const name of [
    'startBeaconRoot',
    'endBeaconRoot',
    'syncCommitteeRoot',
    'genesisValidatorsRoot',
    'updateChainRoot',
    'updateVkey',
    'accumulatorVkey',
    'publicValuesSha256',
  ]) requireHex32(checkpoint[name], name);
  requireForkVersion(checkpoint.forkVersion);
  requireAoId(checkpoint.proofRef, 'proofRef');
  if (checkpoint.previousCommitId !== null) {
    requireAoId(checkpoint.previousCommitId, 'previousCommitId');
  }

  if (checkpoint.updateVkey !== config.updateVkey) throw new Error('update vkey anchor changed');
  if (checkpoint.accumulatorVkey !== config.accumulatorVkey) throw new Error('accumulator vkey anchor changed');
  if (checkpoint.syncCommitteeRoot !== config.syncCommitteeRoot) throw new Error('sync committee anchor changed');
  if (checkpoint.genesisValidatorsRoot !== config.genesisValidatorsRoot) throw new Error('genesis validators root changed');
  if (checkpoint.forkVersion !== config.forkVersion) throw new Error('fork version changed');

  return Object.freeze({
    kind: checkpoint.kind,
    version: checkpoint.version,
    startSlot: checkpoint.startSlot,
    endSlot: checkpoint.endSlot,
    updateCount: checkpoint.updateCount,
    startBeaconRoot: checkpoint.startBeaconRoot,
    endBeaconRoot: checkpoint.endBeaconRoot,
    syncCommitteeRoot: checkpoint.syncCommitteeRoot,
    genesisValidatorsRoot: checkpoint.genesisValidatorsRoot,
    updateChainRoot: checkpoint.updateChainRoot,
    updateVkey: checkpoint.updateVkey,
    accumulatorVkey: checkpoint.accumulatorVkey,
    forkVersion: checkpoint.forkVersion,
    publicValuesSha256: checkpoint.publicValuesSha256,
    proofRef: checkpoint.proofRef,
    previousCommitId: checkpoint.previousCommitId,
  });
}

function requireObject(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${name} must be an object`);
  }
}

function requireHex32(value, name) {
  if (typeof value !== 'string' || !HEX32.test(value)) {
    throw new Error(`${name} must be a lowercase 0x-prefixed 32-byte hex value`);
  }
}

function requireForkVersion(value) {
  if (typeof value !== 'string' || !FORK_VERSION.test(value)) {
    throw new Error('forkVersion must be a lowercase 0x-prefixed 4-byte hex value');
  }
}

function requireAoId(value, name) {
  if (typeof value !== 'string' || !AO_ID.test(value)) {
    throw new Error(`${name} must be a 43-character AO/Arweave id`);
  }
}

function requireDecimal(value, name) {
  if (typeof value !== 'string' || !DECIMAL.test(value)) {
    throw new Error(`${name} must be a canonical unsigned decimal string`);
  }
}

function asBigInt(value, name) {
  requireDecimal(value, name);
  return BigInt(value);
}
