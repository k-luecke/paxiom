// Operator wallet registry (#90) — the hybrid allowlist.
//
//   effective allowlist = env ∪ store
//
// The env seed (PAXIOM_ALLOWED_WALLETS) is the root of trust: those wallets
// are always admins, they cannot be demoted or removed through the API, and
// an empty env still refuses to start. That is what keeps this from being the
// trust-on-first-use hole M-18 was about — the first wallet is gated by
// deploy, not by whoever reaches the console first.
//
// Everything above that seed is operator-managed at runtime: an authenticated
// admin may add wallets, promote and demote them, and remove them, with every
// change written through the shared ConfigStore and its audit chain.
//
// This module also defines the admin/member role that #92, #96, #98 and #106
// gate their own surfaces on. It deliberately does not know about HTTP; the
// server maps the thrown `.status` onto a response.

import { readConfig, writeConfig } from '../services/shared/config-store.mjs';

export const CONFIG_NAME = 'wallets';
export const ROLE_ADMIN = 'admin';
export const ROLE_MEMBER = 'member';
export const ROLES = Object.freeze([ROLE_ADMIN, ROLE_MEMBER]);

const ADDRESS_RE = /^0x[0-9a-f]{40}$/;
const EMPTY_STORE = Object.freeze({ admins: [], members: [], updatedAt: null, updatedBy: null });

function fail(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

/** Lowercase a 0x address, or return null if it is not one. */
export function normalizeAddress(value) {
  const a = String(value ?? '').trim().toLowerCase();
  return ADDRESS_RE.test(a) ? a : null;
}

export function parseAddressList(raw) {
  return [...new Set(
    String(raw ?? '').split(',').map(normalizeAddress).filter(Boolean),
  )];
}

/** The env seed. Always admins; never mutable through the API. */
export function envAdmins(env = process.env) {
  return parseAddressList(env.PAXIOM_ALLOWED_WALLETS);
}

/**
 * Refuse to start without an env seed. Called from createApp() rather than at
 * module load, so the module can be imported by a test or an analyzer — the
 * refusal still happens before the server accepts a connection, which is what
 * the M-18 invariant actually requires.
 */
export function assertBootConfig(env = process.env) {
  if (envAdmins(env).length === 0) {
    throw new Error(
      'PAXIOM_ALLOWED_WALLETS must list >=1 valid 0x-address (40 hex chars); refusing to start',
    );
  }
}

export function readWalletStore(env = process.env) {
  const raw = readConfig(CONFIG_NAME, { fallback: EMPTY_STORE, env }) ?? EMPTY_STORE;
  return {
    admins: parseAddressList((raw.admins ?? []).join(',')),
    members: parseAddressList((raw.members ?? []).join(',')),
    updatedAt: raw.updatedAt ?? null,
    updatedBy: raw.updatedBy ?? null,
  };
}

/**
 * Effective view. `storeAdmins` and `members` exclude anything already in the
 * env seed, so each address appears exactly once and its source is unambiguous.
 */
export function snapshot(env = process.env) {
  const seed = envAdmins(env);
  const store = readWalletStore(env);
  const seedSet = new Set(seed);
  return {
    envAdmins: seed,
    storeAdmins: store.admins.filter((a) => !seedSet.has(a)),
    members: store.members.filter((a) => !seedSet.has(a) && !store.admins.includes(a)),
    updatedAt: store.updatedAt,
    updatedBy: store.updatedBy,
  };
}

/** 'admin' | 'member' | null. The env seed outranks whatever the store says. */
export function roleFor(address, env = process.env) {
  const a = normalizeAddress(address);
  if (!a) return null;
  if (envAdmins(env).includes(a)) return ROLE_ADMIN;
  const store = readWalletStore(env);
  if (store.admins.includes(a)) return ROLE_ADMIN;
  if (store.members.includes(a)) return ROLE_MEMBER;
  return null;
}

export function isAllowed(address, env = process.env) {
  return roleFor(address, env) !== null;
}

export function isEnvAdmin(address, env = process.env) {
  const a = normalizeAddress(address);
  return a != null && envAdmins(env).includes(a);
}

function requireValidAddress(address) {
  const a = normalizeAddress(address);
  if (!a) throw fail(400, 'address must be a 20-byte hex address');
  return a;
}

function requireValidRole(role) {
  if (!ROLES.includes(role)) throw fail(400, `role must be one of: ${ROLES.join(', ')}`);
  return role;
}

function persist(next, { actor, action, reason, env }) {
  const value = {
    admins: next.admins,
    members: next.members,
    updatedAt: new Date().toISOString(),
    updatedBy: actor,
  };
  writeConfig(CONFIG_NAME, value, { actor, action, reason, env });
  return snapshot(env);
}

/** Add a wallet at the given role. */
export function addWallet({ address, role = ROLE_MEMBER, actor, env = process.env, reason } = {}) {
  const a = requireValidAddress(address);
  requireValidRole(role);
  if (isEnvAdmin(a, env)) {
    throw fail(409, 'wallet is an env-seeded admin; it is already allowlisted and cannot be changed here');
  }
  const store = readWalletStore(env);
  if (store.admins.includes(a) || store.members.includes(a)) {
    throw fail(409, 'wallet is already in the allowlist; use the role endpoint to change its role');
  }
  const next = {
    admins: role === ROLE_ADMIN ? [...store.admins, a] : store.admins,
    members: role === ROLE_MEMBER ? [...store.members, a] : store.members,
  };
  return persist(next, { actor, action: `wallets.add.${role}`, reason, env });
}

/** Remove a store-managed wallet. Env-seeded admins are refused. */
export function removeWallet({ address, actor, env = process.env, reason } = {}) {
  const a = requireValidAddress(address);
  if (isEnvAdmin(a, env)) {
    throw fail(409, 'wallet is an env-seeded admin; remove it from PAXIOM_ALLOWED_WALLETS and restart');
  }
  const store = readWalletStore(env);
  if (!store.admins.includes(a) && !store.members.includes(a)) {
    throw fail(404, 'wallet is not in the store-managed allowlist');
  }
  const next = {
    admins: store.admins.filter((x) => x !== a),
    members: store.members.filter((x) => x !== a),
  };
  return persist(next, { actor, action: 'wallets.remove', reason, env });
}

/** Promote or demote a store-managed wallet. Env-seeded admins are refused. */
export function setWalletRole({ address, role, actor, env = process.env, reason } = {}) {
  const a = requireValidAddress(address);
  requireValidRole(role);
  if (isEnvAdmin(a, env)) {
    throw fail(409, 'wallet is an env-seeded admin; its role is fixed by PAXIOM_ALLOWED_WALLETS');
  }
  const store = readWalletStore(env);
  if (!store.admins.includes(a) && !store.members.includes(a)) {
    throw fail(404, 'wallet is not in the store-managed allowlist');
  }
  const admins = store.admins.filter((x) => x !== a);
  const members = store.members.filter((x) => x !== a);
  const next = {
    admins: role === ROLE_ADMIN ? [...admins, a] : admins,
    members: role === ROLE_MEMBER ? [...members, a] : members,
  };
  return persist(next, { actor, action: `wallets.role.${role}`, reason, env });
}
