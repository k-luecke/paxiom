// Operator wallet registry (#90): env seeds the root of trust, the store
// manages everything above it.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readAuditLog, verifyAuditChain, writeConfig } from '../../services/shared/config-store.mjs';
import {
  CONFIG_NAME, ROLE_ADMIN, ROLE_MEMBER,
  normalizeAddress, parseAddressList, envAdmins, assertBootConfig,
  snapshot, roleFor, isAllowed, isEnvAdmin,
  addWallet, removeWallet, setWalletRole,
} from '../wallet-registry.mjs';

const SEED = '0x00000000000000000000000000000000000000a1';
const OTHER = '0x00000000000000000000000000000000000000b2';
const THIRD = '0x00000000000000000000000000000000000000c3';
const ADMIN_ACTOR = '0xopadmin';

function sandbox(seed = SEED) {
  const root = mkdtempSync(join(tmpdir(), 'paxiom-wallets-'));
  return {
    PAXIOM_CONFIG_DIR: join(root, 'config'),
    PAXIOM_AUDIT_LOG_DIR: join(root, 'log'),
    PAXIOM_ALLOWED_WALLETS: seed,
  };
}

// ── address handling ──────────────────────────────────────────────────────

test('addresses normalize to lowercase and reject non-addresses', () => {
  assert.equal(normalizeAddress('0x00000000000000000000000000000000000000A1'), SEED);
  assert.equal(normalizeAddress('  ' + SEED + ' '), SEED);
  for (const bad of ['', null, undefined, '0x123', 'not-an-address', SEED + 'ff']) {
    assert.equal(normalizeAddress(bad), null, `${bad} must not parse`);
  }
});

test('the env list tolerates whitespace, case and junk entries', () => {
  assert.deepEqual(parseAddressList(` ${SEED.toUpperCase()} , nonsense, ${OTHER} , ${SEED}`),
    [SEED, OTHER], 'junk dropped, duplicates collapsed');
  assert.deepEqual(parseAddressList(''), []);
  assert.deepEqual(parseAddressList(undefined), []);
});

// ── boot invariant (M-18) ─────────────────────────────────────────────────

test('an empty env seed refuses to boot', () => {
  assert.throws(() => assertBootConfig({ PAXIOM_ALLOWED_WALLETS: '' }), /refusing to start/);
  assert.throws(() => assertBootConfig({}), /refusing to start/);
  assert.throws(() => assertBootConfig({ PAXIOM_ALLOWED_WALLETS: 'not-an-address' }),
    /refusing to start/, 'a list of junk is an empty list');
});

test('a valid env seed boots', () => {
  assert.doesNotThrow(() => assertBootConfig({ PAXIOM_ALLOWED_WALLETS: SEED }));
  assert.deepEqual(envAdmins({ PAXIOM_ALLOWED_WALLETS: SEED }), [SEED]);
});

// ── effective allowlist ───────────────────────────────────────────────────

test('with an empty store the env seed is the whole allowlist', () => {
  const env = sandbox();
  assert.equal(roleFor(SEED, env), ROLE_ADMIN);
  assert.equal(roleFor(OTHER, env), null);
  assert.equal(isAllowed(OTHER, env), false);
  assert.deepEqual(snapshot(env), {
    envAdmins: [SEED], storeAdmins: [], members: [], updatedAt: null, updatedBy: null,
  });
});

test('an added member is allowlisted but not an admin', () => {
  const env = sandbox();
  addWallet({ address: OTHER, role: ROLE_MEMBER, actor: ADMIN_ACTOR, env });
  assert.equal(roleFor(OTHER, env), ROLE_MEMBER);
  assert.equal(isAllowed(OTHER, env), true);
  assert.deepEqual(snapshot(env).members, [OTHER]);
});

test('an added admin is an admin', () => {
  const env = sandbox();
  addWallet({ address: OTHER, role: ROLE_ADMIN, actor: ADMIN_ACTOR, env });
  assert.equal(roleFor(OTHER, env), ROLE_ADMIN);
  assert.deepEqual(snapshot(env).storeAdmins, [OTHER]);
});

test('addresses are matched case-insensitively throughout', () => {
  const env = sandbox();
  addWallet({ address: OTHER.toUpperCase(), role: ROLE_MEMBER, actor: ADMIN_ACTOR, env });
  assert.equal(roleFor(OTHER.toUpperCase(), env), ROLE_MEMBER);
  assert.equal(roleFor(OTHER, env), ROLE_MEMBER);
});

// ── the env seed outranks the store ───────────────────────────────────────

test('an env wallet cannot be removed through the API', () => {
  const env = sandbox();
  assert.throws(() => removeWallet({ address: SEED, actor: ADMIN_ACTOR, env }),
    (e) => e.status === 409 && /PAXIOM_ALLOWED_WALLETS/.test(e.message));
  assert.equal(roleFor(SEED, env), ROLE_ADMIN, 'still an admin after the refused removal');
});

test('an env wallet cannot be demoted through the API', () => {
  const env = sandbox();
  assert.throws(() => setWalletRole({ address: SEED, role: ROLE_MEMBER, actor: ADMIN_ACTOR, env }),
    (e) => e.status === 409);
  assert.equal(roleFor(SEED, env), ROLE_ADMIN);
});

test('an env wallet cannot be re-added to the store', () => {
  const env = sandbox();
  assert.throws(() => addWallet({ address: SEED, role: ROLE_MEMBER, actor: ADMIN_ACTOR, env }),
    (e) => e.status === 409, 'adding it as a member must not look like a successful demotion');
});

test('a store entry can never downgrade an env admin', () => {
  // Even if the file is hand-edited to list the seed as a member, env wins.
  const env = sandbox();
  addWallet({ address: OTHER, role: ROLE_MEMBER, actor: ADMIN_ACTOR, env });
  writeConfig(CONFIG_NAME, { admins: [], members: [SEED, OTHER] },
    { actor: 'hand-edit', action: 'test.tamper', env });
  assert.equal(roleFor(SEED, env), ROLE_ADMIN, 'the env seed outranks the file');
  assert.deepEqual(snapshot(env).members, [OTHER], 'the seed is not double-listed');
});

// ── mutations ─────────────────────────────────────────────────────────────

test('a wallet cannot be added twice', () => {
  const env = sandbox();
  addWallet({ address: OTHER, role: ROLE_MEMBER, actor: ADMIN_ACTOR, env });
  assert.throws(() => addWallet({ address: OTHER, role: ROLE_ADMIN, actor: ADMIN_ACTOR, env }),
    (e) => e.status === 409 && /role endpoint/.test(e.message));
});

test('promote and demote move a wallet between the two lists', () => {
  const env = sandbox();
  addWallet({ address: OTHER, role: ROLE_MEMBER, actor: ADMIN_ACTOR, env });
  setWalletRole({ address: OTHER, role: ROLE_ADMIN, actor: ADMIN_ACTOR, env });
  assert.deepEqual(snapshot(env).storeAdmins, [OTHER]);
  assert.deepEqual(snapshot(env).members, [], 'not left in both lists');
  setWalletRole({ address: OTHER, role: ROLE_MEMBER, actor: ADMIN_ACTOR, env });
  assert.deepEqual(snapshot(env).storeAdmins, []);
  assert.deepEqual(snapshot(env).members, [OTHER]);
});

test('removing a store wallet revokes access', () => {
  const env = sandbox();
  addWallet({ address: OTHER, role: ROLE_ADMIN, actor: ADMIN_ACTOR, env });
  removeWallet({ address: OTHER, actor: ADMIN_ACTOR, env });
  assert.equal(roleFor(OTHER, env), null);
  assert.equal(isAllowed(OTHER, env), false);
});

test('operating on an unknown wallet is a 404, not a silent no-op', () => {
  const env = sandbox();
  assert.throws(() => removeWallet({ address: THIRD, actor: ADMIN_ACTOR, env }), (e) => e.status === 404);
  assert.throws(() => setWalletRole({ address: THIRD, role: ROLE_ADMIN, actor: ADMIN_ACTOR, env }),
    (e) => e.status === 404);
});

test('malformed input is rejected before anything is written', () => {
  const env = sandbox();
  assert.throws(() => addWallet({ address: 'nope', actor: ADMIN_ACTOR, env }), (e) => e.status === 400);
  assert.throws(() => addWallet({ address: OTHER, role: 'superuser', actor: ADMIN_ACTOR, env }),
    (e) => e.status === 400);
  assert.deepEqual(snapshot(env).members, [], 'nothing was persisted');
});

// ── persistence and audit ─────────────────────────────────────────────────

test('the store survives a restart', () => {
  const env = sandbox();
  addWallet({ address: OTHER, role: ROLE_ADMIN, actor: ADMIN_ACTOR, env });
  addWallet({ address: THIRD, role: ROLE_MEMBER, actor: ADMIN_ACTOR, env });
  // A "restart" is just reading again from the same directory with no cache.
  const after = snapshot({ ...env });
  assert.deepEqual(after.storeAdmins, [OTHER]);
  assert.deepEqual(after.members, [THIRD]);
  assert.equal(roleFor(OTHER, { ...env }), ROLE_ADMIN);
});

test('every mutation is attributed and audited, and the chain verifies', () => {
  const env = sandbox();
  addWallet({ address: OTHER, role: ROLE_MEMBER, actor: ADMIN_ACTOR, env, reason: 'onboard' });
  setWalletRole({ address: OTHER, role: ROLE_ADMIN, actor: ADMIN_ACTOR, env });
  removeWallet({ address: OTHER, actor: ADMIN_ACTOR, env, reason: 'offboard' });

  const log = readAuditLog(CONFIG_NAME, env);
  assert.deepEqual(log.map((r) => r.action),
    ['wallets.add.member', 'wallets.role.admin', 'wallets.remove']);
  assert.ok(log.every((r) => r.actor === ADMIN_ACTOR), 'every record names who did it');
  assert.equal(log[0].reason, 'onboard');
  assert.equal(log[2].reason, 'offboard');
  assert.equal(verifyAuditChain(CONFIG_NAME, { env }).ok, true);
});

test('the store records who changed it and when', () => {
  const env = sandbox();
  addWallet({ address: OTHER, role: ROLE_MEMBER, actor: ADMIN_ACTOR, env });
  const snap = snapshot(env);
  assert.equal(snap.updatedBy, ADMIN_ACTOR);
  assert.ok(Date.parse(snap.updatedAt) > 0, 'updatedAt is a timestamp');
});

test('isEnvAdmin distinguishes the seed from store admins', () => {
  const env = sandbox();
  addWallet({ address: OTHER, role: ROLE_ADMIN, actor: ADMIN_ACTOR, env });
  assert.equal(isEnvAdmin(SEED, env), true);
  assert.equal(isEnvAdmin(OTHER, env), false, 'a store admin is removable; an env admin is not');
  assert.equal(roleFor(OTHER, env), ROLE_ADMIN, 'both are admins for authorization purposes');
});
