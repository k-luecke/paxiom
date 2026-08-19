// Shared ConfigStore — the persistence layer for operator-mutable config.
//
// One JSON file per concern under PAXIOM_CONFIG_DIR, each with an adjacent
// append-only audit log carrying a prev/next hash chain. The deployment
// contract is docs/vps-deploy.md; this is its implementation.
//
//   wallets.json        #90   admin/member allowlist above the env seed
//   controls.json       #92   liveTransactionsEnabled and other kill switches
//   x402-config.json    #96   facilitator selection, per-service price overrides
//   signing-config.json #98   active key id, JWKS publication set
//   peer-migration.json #106  peer-config drain state
//
// Three invariants everything here exists to hold:
//
//   1. A half-written config is never readable. Writes go to a temp file in
//      the same directory, are fsynced, then rename(2)d over the target.
//      rename is atomic within a filesystem; write is not.
//   2. Config files are 0600. Set explicitly rather than relying on the
//      service umask, so a store created by a test or a CLI is not laxer than
//      one created by systemd (which also sets UMask=0077).
//   3. Every mutation is recorded, and history cannot be rewritten
//      undetectably. Each audit record hashes itself plus its predecessor, so
//      deleting or editing a record breaks verification from that point on.
//
// Single writer, by design. The audit chain is appended and the config file
// replaced without an inter-process lock, because the deployment model
// (docs/vps-deploy.md) puts one writer — the operator console — on one host,
// and mutations are human-paced. Two concurrent writers could interleave an
// append and a read-modify-write and fork the chain. If a second writer is
// ever introduced, this needs a lock before it needs anything else.
//
// This module deliberately knows nothing about roles or authentication. The
// caller decides who may mutate and passes an `actor` for the audit trail;
// #90 supplies the admin model that fills it in.

import { createHash } from 'node:crypto';
import {
  closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync,
  renameSync, unlinkSync, writeFileSync, writeSync, appendFileSync, statSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const DEFAULT_CONFIG_DIR = '/var/lib/paxiom/config';
const DEFAULT_AUDIT_DIR = '/var/log/paxiom';
export const GENESIS_PREV = '0'.repeat(64);
const FILE_MODE = 0o600;
const DIR_MODE = 0o700;

export function configDir(env = process.env) {
  return resolve(env.PAXIOM_CONFIG_DIR || DEFAULT_CONFIG_DIR);
}

// Audit logs live with the other logs, not beside the config, so log rotation
// and retention policy apply to them without touching the config directory.
export function auditDir(env = process.env) {
  return resolve(env.PAXIOM_AUDIT_LOG_DIR || DEFAULT_AUDIT_DIR);
}

export function configPath(name, env = process.env) {
  return join(configDir(env), `${name}.json`);
}

export function auditPath(name, env = process.env) {
  return join(auditDir(env), `${name}.audit.log`);
}

// Deterministic serialization. Object key order must not change a hash, or
// the chain would break on a round-trip through a JSON parser that reorders.
function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
}

export function hashRecord(record) {
  const { self, ...rest } = record;
  return createHash('sha256').update(canonical(rest)).digest('hex');
}

function ensureDir(path, mode) {
  if (!existsSync(path)) mkdirSync(path, { recursive: true, mode });
}

// Write, fsync, rename, then fsync the directory. Without the directory fsync
// the rename itself can be lost on power failure even though the file content
// was durable.
function writeFileAtomic(path, contents) {
  ensureDir(dirname(path), DIR_MODE);
  const tmp = `${path}.tmp`;
  const fd = openSync(tmp, 'w', FILE_MODE);
  try {
    writeSync(fd, contents);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(tmp, path);
  } catch (e) {
    try { unlinkSync(tmp); } catch { /* best effort */ }
    throw e;
  }
  const dirFd = openSync(dirname(path), 'r');
  try { fsyncSync(dirFd); } finally { closeSync(dirFd); }
}

/** Read a config file. Returns `fallback` when it does not exist yet. */
export function readConfig(name, { fallback = null, env = process.env } = {}) {
  const path = configPath(name, env);
  if (!existsSync(path)) return fallback;
  return JSON.parse(readFileSync(path, 'utf8'));
}

/** Last record in a config's audit log, or null when there is none. */
export function lastAuditRecord(name, env = process.env) {
  const path = auditPath(name, env);
  if (!existsSync(path)) return null;
  const lines = readFileSync(path, 'utf8').split('\n').filter(Boolean);
  if (lines.length === 0) return null;
  return JSON.parse(lines[lines.length - 1]);
}

export function readAuditLog(name, env = process.env) {
  const path = auditPath(name, env);
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

/**
 * Replace a config's contents and append an audit record.
 *
 * The audit record is appended BEFORE the config is renamed into place. A
 * crash between the two leaves a record for a change that did not take effect,
 * which is detectable by comparing `after` against the file. The reverse order
 * would leave a change with no record, which is not detectable at all — and an
 * audit trail that can silently miss entries is worse than none.
 */
export function writeConfig(name, value, { actor, action, reason, env = process.env, now } = {}) {
  if (!actor) throw new Error(`writeConfig(${name}): actor is required for the audit trail`);
  if (!action) throw new Error(`writeConfig(${name}): action is required for the audit trail`);

  const before = readConfig(name, { env });
  const prev = lastAuditRecord(name, env)?.self ?? GENESIS_PREV;
  const record = {
    ts: new Date(now ?? Date.now()).toISOString(),
    actor,
    action,
    reason: reason ?? null,
    before,
    after: value,
    prev,
  };
  record.self = hashRecord(record);

  ensureDir(auditDir(env), DIR_MODE);
  const alog = auditPath(name, env);
  if (!existsSync(alog)) writeFileSync(alog, '', { mode: FILE_MODE });
  appendFileSync(alog, `${JSON.stringify(record)}\n`);

  writeFileAtomic(configPath(name, env), `${JSON.stringify(value, null, 2)}\n`);
  return record;
}

/** Read-modify-write helper. `fn` receives the current value and returns the next. */
export function mutateConfig(name, fn, { fallback = {}, ...meta } = {}) {
  const current = readConfig(name, { fallback, env: meta.env });
  const next = fn(structuredClone(current));
  return writeConfig(name, next, meta);
}

/**
 * Verify a config's audit chain end to end.
 *
 * Returns `{ ok, length, brokenAt, reason }`. `brokenAt` is the 0-based index
 * of the first record that fails, so an operator can see how much history is
 * trustworthy rather than just that something is wrong.
 *
 * Rotation does not break the chain — links are content hashes, not offsets —
 * but records must be supplied oldest-first across rotated files.
 */
export function verifyAuditChain(name, { env = process.env, records } = {}) {
  const log = records ?? readAuditLog(name, env);
  let prev = GENESIS_PREV;
  for (let i = 0; i < log.length; i++) {
    const rec = log[i];
    if (rec.prev !== prev) {
      return { ok: false, length: log.length, brokenAt: i, reason: 'prev-mismatch' };
    }
    if (rec.self !== hashRecord(rec)) {
      return { ok: false, length: log.length, brokenAt: i, reason: 'self-hash-mismatch' };
    }
    prev = rec.self;
  }
  return { ok: true, length: log.length, brokenAt: null, reason: null };
}

/** File mode of a config, for tests and operator checks. */
export function configMode(name, env = process.env) {
  return statSync(configPath(name, env)).mode & 0o777;
}
