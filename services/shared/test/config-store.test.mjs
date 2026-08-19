// ConfigStore foundation tests (#96).
//
// The three invariants this layer exists to hold: writes are atomic and 0600,
// every mutation is audited, and tampering with history is detectable.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  configDir, auditDir, configPath, auditPath, readConfig, writeConfig,
  mutateConfig, readAuditLog, verifyAuditChain, configMode, hashRecord,
  GENESIS_PREV,
} from '../config-store.mjs';

function sandbox() {
  const root = mkdtempSync(join(tmpdir(), 'paxiom-cfg-'));
  return { PAXIOM_CONFIG_DIR: join(root, 'config'), PAXIOM_AUDIT_LOG_DIR: join(root, 'log') };
}

const META = { actor: '0xabc', action: 'test.write' };

test('directories resolve from env, with documented defaults', () => {
  assert.equal(configDir({}), '/var/lib/paxiom/config');
  assert.equal(auditDir({}), '/var/log/paxiom');
  const env = sandbox();
  assert.equal(configPath('x402-config', env), join(env.PAXIOM_CONFIG_DIR, 'x402-config.json'));
  assert.equal(auditPath('x402-config', env), join(env.PAXIOM_AUDIT_LOG_DIR, 'x402-config.audit.log'));
});

test('reading a config that does not exist returns the fallback', () => {
  const env = sandbox();
  assert.equal(readConfig('missing', { env }), null);
  assert.deepEqual(readConfig('missing', { env, fallback: { a: 1 } }), { a: 1 });
});

test('write then read round-trips, and the file is 0600', () => {
  const env = sandbox();
  writeConfig('controls', { liveTransactionsEnabled: false }, { ...META, env });
  assert.deepEqual(readConfig('controls', { env }), { liveTransactionsEnabled: false });
  assert.equal(configMode('controls', env), 0o600);
});

test('writes leave no temp file behind', () => {
  const env = sandbox();
  writeConfig('controls', { a: 1 }, { ...META, env });
  writeConfig('controls', { a: 2 }, { ...META, env });
  const stray = readdirSync(env.PAXIOM_CONFIG_DIR).filter((f) => f.endsWith('.tmp'));
  assert.deepEqual(stray, [], 'no .tmp files should survive a completed write');
});

test('actor and action are mandatory — an unattributable mutation is refused', () => {
  const env = sandbox();
  assert.throws(() => writeConfig('c', {}, { action: 'a', env }), /actor is required/);
  assert.throws(() => writeConfig('c', {}, { actor: '0x1', env }), /action is required/);
  assert.equal(existsSync(configPath('c', env)), false, 'a refused write must not create the file');
});

test('every mutation appends an audit record with before/after', () => {
  const env = sandbox();
  writeConfig('wallets', { admins: ['0x1'] }, { actor: '0xop', action: 'wallets.init', env });
  writeConfig('wallets', { admins: ['0x1', '0x2'] },
    { actor: '0xop', action: 'wallets.add', reason: 'onboard second operator', env });

  const log = readAuditLog('wallets', env);
  assert.equal(log.length, 2);
  assert.equal(log[0].before, null, 'first record has no prior state');
  assert.deepEqual(log[0].after, { admins: ['0x1'] });
  assert.deepEqual(log[1].before, { admins: ['0x1'] });
  assert.deepEqual(log[1].after, { admins: ['0x1', '0x2'] });
  assert.equal(log[1].actor, '0xop');
  assert.equal(log[1].reason, 'onboard second operator');
});

test('the chain starts at genesis and links each record to its predecessor', () => {
  const env = sandbox();
  writeConfig('c', { n: 1 }, { ...META, env });
  writeConfig('c', { n: 2 }, { ...META, env });
  writeConfig('c', { n: 3 }, { ...META, env });

  const log = readAuditLog('c', env);
  assert.equal(log[0].prev, GENESIS_PREV);
  assert.equal(log[1].prev, log[0].self);
  assert.equal(log[2].prev, log[1].self);
  assert.deepEqual(verifyAuditChain('c', { env }), {
    ok: true, length: 3, brokenAt: null, reason: null,
  });
});

test('editing a record in place is detected', () => {
  const env = sandbox();
  writeConfig('c', { n: 1 }, { ...META, env });
  writeConfig('c', { n: 2 }, { ...META, env });
  writeConfig('c', { n: 3 }, { ...META, env });

  const log = readAuditLog('c', env);
  log[1].after = { n: 99 };   // rewrite history, leave the hashes alone
  const v = verifyAuditChain('c', { env, records: log });
  assert.equal(v.ok, false);
  assert.equal(v.brokenAt, 1);
  assert.equal(v.reason, 'self-hash-mismatch');
});

test('deleting a record from the middle is detected', () => {
  const env = sandbox();
  writeConfig('c', { n: 1 }, { ...META, env });
  writeConfig('c', { n: 2 }, { ...META, env });
  writeConfig('c', { n: 3 }, { ...META, env });

  const log = readAuditLog('c', env);
  log.splice(1, 1);
  const v = verifyAuditChain('c', { env, records: log });
  assert.equal(v.ok, false);
  assert.equal(v.brokenAt, 1, 'the record that used to follow the deleted one breaks');
  assert.equal(v.reason, 'prev-mismatch');
});

test('re-hashing an edited record does not repair the chain', () => {
  // The interesting attack: an editor who knows the scheme fixes up `self`.
  // The following record's `prev` still points at the old hash.
  const env = sandbox();
  writeConfig('c', { n: 1 }, { ...META, env });
  writeConfig('c', { n: 2 }, { ...META, env });
  writeConfig('c', { n: 3 }, { ...META, env });

  const log = readAuditLog('c', env);
  log[1].after = { n: 99 };
  log[1].self = hashRecord(log[1]);
  const v = verifyAuditChain('c', { env, records: log });
  assert.equal(v.ok, false);
  assert.equal(v.brokenAt, 2);
  assert.equal(v.reason, 'prev-mismatch');
});

test('truncating the tail is NOT detectable from the log alone', () => {
  // Honest limit of a hash chain: dropping the most recent records leaves a
  // shorter but internally consistent chain. Detecting that needs an external
  // anchor — an off-host copy, or the Merkle checkpoint in #115.
  const env = sandbox();
  writeConfig('c', { n: 1 }, { ...META, env });
  writeConfig('c', { n: 2 }, { ...META, env });
  writeConfig('c', { n: 3 }, { ...META, env });

  const log = readAuditLog('c', env).slice(0, 2);
  assert.equal(verifyAuditChain('c', { env, records: log }).ok, true);
});

test('key order does not affect the hash', () => {
  // Records survive a round-trip through parsers that reorder keys.
  const a = { ts: 't', actor: 'x', action: 'a', before: { p: 1, q: 2 }, after: null, prev: GENESIS_PREV };
  const b = { prev: GENESIS_PREV, after: null, before: { q: 2, p: 1 }, action: 'a', actor: 'x', ts: 't' };
  assert.equal(hashRecord(a), hashRecord(b));
});

test('mutateConfig applies a function to the current value', () => {
  const env = sandbox();
  writeConfig('c', { list: ['a'] }, { ...META, env });
  mutateConfig('c', (cur) => ({ ...cur, list: [...cur.list, 'b'] }),
    { actor: '0xop', action: 'c.append', env });
  assert.deepEqual(readConfig('c', { env }), { list: ['a', 'b'] });
  assert.equal(verifyAuditChain('c', { env }).ok, true);
});

test('mutateConfig does not let the callback mutate the stored object', () => {
  const env = sandbox();
  writeConfig('c', { list: ['a'] }, { ...META, env });
  mutateConfig('c', (cur) => { cur.list.push('mutated'); return { list: ['b'] }; },
    { actor: '0xop', action: 'c.replace', env });
  assert.deepEqual(readConfig('c', { env }), { list: ['b'] });
  const log = readAuditLog('c', env);
  assert.deepEqual(log[1].before, { list: ['a'] }, 'before reflects stored state, not the callback scratch');
});

test('a config written outside the store still audits its own replacement', () => {
  const env = sandbox();
  writeConfig('c', { n: 1 }, { ...META, env });
  writeFileSync(configPath('c', env), JSON.stringify({ n: 'hand-edited' }));
  const rec = writeConfig('c', { n: 2 }, { ...META, env });
  assert.deepEqual(rec.before, { n: 'hand-edited' },
    'the audit trail records what was actually there, not what the log expected');
});
