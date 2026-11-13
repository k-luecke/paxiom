import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  commitCheckpoint,
  createCheckpointState,
  RECURSIVE_CHECKPOINT_KIND,
} from '../recursive-checkpoint.mjs';

const id = (char) => char.repeat(43);
const hex = (char) => `0x${char.repeat(64)}`;
const config = {
  verifierAuthority: id('V'),
  updateVkey: hex('1'),
  accumulatorVkey: hex('2'),
  syncCommitteeRoot: hex('3'),
  genesisValidatorsRoot: hex('4'),
  forkVersion: '0x06000000',
};

function checkpoint(overrides = {}) {
  return {
    kind: RECURSIVE_CHECKPOINT_KIND,
    version: 1,
    startSlot: '14814118',
    endSlot: '14814120',
    updateCount: '2',
    startBeaconRoot: hex('5'),
    endBeaconRoot: hex('6'),
    syncCommitteeRoot: config.syncCommitteeRoot,
    genesisValidatorsRoot: config.genesisValidatorsRoot,
    updateChainRoot: hex('7'),
    updateVkey: config.updateVkey,
    accumulatorVkey: config.accumulatorVkey,
    forkVersion: config.forkVersion,
    publicValuesSha256: hex('8'),
    proofRef: id('P'),
    previousCommitId: null,
    ...overrides,
  };
}

test('authorized verifier can append a pinned first checkpoint', () => {
  const state = createCheckpointState(config);
  const result = commitCheckpoint(state, {
    from: config.verifierAuthority,
    commitId: id('A'),
    checkpoint: checkpoint(),
  });
  assert.equal(result.commitId, id('A'));
  assert.equal(state.latest, result);
  assert.equal(state.count, 1);
});

test('registry rejects unauthenticated proof-verification claims', () => {
  const state = createCheckpointState(config);
  assert.throws(() => commitCheckpoint(state, {
    from: id('X'),
    commitId: id('A'),
    checkpoint: checkpoint(),
  }), /unauthorized/);
});

test('registry pins program, committee, network, and fork anchors', () => {
  for (const mutation of [
    { updateVkey: hex('9') },
    { accumulatorVkey: hex('9') },
    { syncCommitteeRoot: hex('9') },
    { genesisValidatorsRoot: hex('9') },
    { forkVersion: '0x05000000' },
  ]) {
    const state = createCheckpointState(config);
    assert.throws(() => commitCheckpoint(state, {
      from: config.verifierAuthority,
      commitId: id('A'),
      checkpoint: checkpoint(mutation),
    }), /changed/);
  }
});

test('registry enforces AO commit linkage and monotonic rolling state', () => {
  const state = createCheckpointState(config);
  commitCheckpoint(state, {
    from: config.verifierAuthority,
    commitId: id('A'),
    checkpoint: checkpoint(),
  });

  assert.throws(() => commitCheckpoint(state, {
    from: config.verifierAuthority,
    commitId: id('B'),
    checkpoint: checkpoint({ endSlot: '14814121', updateCount: '3', previousCommitId: id('Z') }),
  }), /does not match/);

  const next = commitCheckpoint(state, {
    from: config.verifierAuthority,
    commitId: id('B'),
    checkpoint: checkpoint({
      endSlot: '14814121',
      endBeaconRoot: hex('9'),
      updateCount: '3',
      updateChainRoot: hex('a'),
      publicValuesSha256: hex('b'),
      proofRef: id('Q'),
      previousCommitId: id('A'),
    }),
  });
  assert.equal(next.updateCount, '3');
  assert.equal(state.count, 2);

  assert.throws(() => commitCheckpoint(state, {
    from: config.verifierAuthority,
    commitId: id('C'),
    checkpoint: checkpoint({
      updateCount: '3',
      endSlot: '14814122',
      previousCommitId: id('B'),
    }),
  }), /updateCount must increase/);
});

test('registry rejects malformed identifiers, roots, and numeric ambiguity', () => {
  for (const mutation of [
    { proofRef: 'not-an-arweave-id' },
    { publicValuesSha256: '0x12' },
    { updateCount: 2 },
    { startSlot: '014814118' },
    { endSlot: '14814118' },
  ]) {
    const state = createCheckpointState(config);
    assert.throws(() => commitCheckpoint(state, {
      from: config.verifierAuthority,
      commitId: id('A'),
      checkpoint: checkpoint(mutation),
    }));
  }
});
