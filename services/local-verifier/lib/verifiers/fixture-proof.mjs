// fixture-proof-verifier-v0
//
// Replays a static MVP fixture stored on disk and compares the
// recomputed decision to the caller's claimed_result.
//
// Today supports one fixture kind: `canonical-json-sha256-v0`.
//   recomputed decision = pass iff sha256(canonical_json(payload)) ===
//                                  fixture.expected_canonical_sha256
//
// Reason codes (per chassis spec):
//   pass: fixture_valid
//   fail: fixture_mismatch | fixture_not_found | malformed_input
//
// All paths issue receipts (no path returns invalid:true) so the audit
// chain stays uninterrupted. HTTP layer maps decision -> status.
//
// No network. No external dependencies beyond node:crypto / node:fs.

import { createHash } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalJson } from '../canonical.mjs';

export const VERIFIER_NAME = 'fixture-proof-verifier-v0';
export const VERIFIER_VERSION = '0.1.0';
export const SUPPORTED_FIXTURE_KINDS = ['canonical-json-sha256-v0'];

const here = dirname(fileURLToPath(import.meta.url));
const DEFAULT_FIXTURE_DIR = join(here, '..', '..', 'fixtures');

const FIXTURE_ID_PATTERN = /^[a-z0-9][a-z0-9_-]*$/i;

export function verify(input, options = {}) {
  const fixtureDir = options.fixtureDir || process.env.PAXIOM_LOCAL_VERIFIER_FIXTURE_DIR || DEFAULT_FIXTURE_DIR;
  const inputHash = safeInputHash(input);

  if (!input || typeof input !== 'object') {
    return fail('malformed_input', inputHash, { detail: 'input must be a JSON object' });
  }
  const { fixture_id, claimed_result } = input;
  if (typeof fixture_id !== 'string' || fixture_id.length === 0) {
    return fail('malformed_input', inputHash, { detail: 'field "fixture_id" must be a non-empty string' });
  }
  if (!FIXTURE_ID_PATTERN.test(fixture_id)) {
    return fail('malformed_input', inputHash, {
      detail: 'fixture_id must match /^[a-z0-9][a-z0-9_-]*$/i (no path separators)',
    });
  }
  if (claimed_result !== 'pass' && claimed_result !== 'fail') {
    return fail('malformed_input', inputHash, { detail: 'field "claimed_result" must be "pass" or "fail"' });
  }

  const fixturePath = join(fixtureDir, `${fixture_id}.json`);
  if (!existsSync(fixturePath)) {
    return fail('fixture_not_found', inputHash, { fixture_id, fixture_dir: fixtureDir });
  }

  let fixture;
  try {
    fixture = JSON.parse(readFileSync(fixturePath, 'utf8'));
  } catch (e) {
    return fail('malformed_input', inputHash, { detail: `fixture is not valid JSON: ${e.message}` });
  }

  if (!fixture || typeof fixture !== 'object') {
    return fail('malformed_input', inputHash, { detail: 'fixture file is not a JSON object' });
  }
  if (fixture.fixture_id !== fixture_id) {
    return fail('malformed_input', inputHash, {
      detail: `fixture_id mismatch: file declares "${fixture.fixture_id}", request asked for "${fixture_id}"`,
    });
  }
  if (!SUPPORTED_FIXTURE_KINDS.includes(fixture.fixture_kind)) {
    return fail('malformed_input', inputHash, {
      detail: `unsupported fixture_kind: ${fixture.fixture_kind}`,
      supported_kinds: SUPPORTED_FIXTURE_KINDS,
    });
  }

  const recomputed = replay(fixture);
  if (recomputed.error) {
    return fail('malformed_input', inputHash, recomputed.error);
  }

  const fixtureContentHash = sha256Hex(canonicalJson(fixture));
  const outputHash = sha256Hex(
    `${fixture.fixture_kind}:${fixtureContentHash}:${recomputed.decision}:${claimed_result}`,
  );

  const details = {
    fixture_id,
    fixture_kind: fixture.fixture_kind,
    fixture_content_sha256: fixtureContentHash,
    recomputed_decision: recomputed.decision,
    claimed_result,
    recomputed: recomputed.evidence,
  };

  if (recomputed.decision === claimed_result) {
    return {
      decision: 'pass',
      reason: 'fixture_valid',
      input_hash: inputHash,
      output_hash: outputHash,
      details,
    };
  }
  return {
    decision: 'fail',
    reason: 'fixture_mismatch',
    input_hash: inputHash,
    output_hash: outputHash,
    details,
  };
}

function replay(fixture) {
  if (fixture.fixture_kind === 'canonical-json-sha256-v0') {
    if (typeof fixture.expected_canonical_sha256 !== 'string') {
      return { error: { detail: 'fixture missing expected_canonical_sha256' } };
    }
    if (typeof fixture.payload === 'undefined') {
      return { error: { detail: 'fixture missing payload' } };
    }
    const recomputed = sha256Hex(canonicalJson(fixture.payload));
    const matches = recomputed === fixture.expected_canonical_sha256.toLowerCase();
    return {
      decision: matches ? 'pass' : 'fail',
      evidence: {
        recomputed_canonical_sha256: recomputed,
        expected_canonical_sha256: fixture.expected_canonical_sha256.toLowerCase(),
        matches,
      },
    };
  }
  return { error: { detail: `unreachable: unsupported fixture_kind ${fixture.fixture_kind}` } };
}

function fail(reason, inputHash, details) {
  return {
    decision: 'fail',
    reason,
    input_hash: inputHash,
    output_hash: sha256Hex(`fail:${reason}:${inputHash || ''}`),
    details,
  };
}

function safeInputHash(input) {
  try {
    return sha256Hex(canonicalJson(input ?? null));
  } catch {
    return sha256Hex('unhashable');
  }
}

function sha256Hex(value) {
  const buf = typeof value === 'string' ? Buffer.from(value, 'utf8') : value;
  return createHash('sha256').update(buf).digest('hex');
}
