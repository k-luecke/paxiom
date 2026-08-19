import { accessSync, constants } from 'node:fs';
import { assertEnvPair, deploymentMode, isStrictDeployment } from './deployment.mjs';

const MOCK_FLAGS = [
  'MOCK_DEVICE',
  'MOCK_LOAD_NETWORK',
  'MOCK_SYNC_COMMITTEE',
  'PAXIOM_ALLOW_MOCK',
  'BLS_ALLOW_MOCK',
];

const REFERENCE_SERVICE_BLOCKERS = {
  'cross-chain-message': 'A-203 still emits reference_evidence_packet; bridge-grade proof verification is not wired yet',
  simulation: 'A-204 still emits deterministic reference receipts; live EVM/TEE execution is not wired yet',
};

const PROOF_ARCHIVE_SERVICES = new Set(['slot-storage-proof', 'historical-state']);

export function preflightService(service = '') {
  const errors = [];
  const warnings = [];

  assertEnvPair('PAXIOM_RESPONSE_SIGNING_PRIVATE_KEY_PEM', 'PAXIOM_RESPONSE_SIGNING_KEY_ID');

  if (!isStrictDeployment()) {
    return { ok: true, mode: deploymentMode() || 'development', errors, warnings };
  }

  if (!process.env.PAXIOM_RESPONSE_SIGNING_PRIVATE_KEY_PEM) {
    errors.push(`PAXIOM_RESPONSE_SIGNING_PRIVATE_KEY_PEM is required in ${deploymentMode()} mode`);
  }
  if (!process.env.PAXIOM_RESPONSE_SIGNING_KEY_ID) {
    errors.push(`PAXIOM_RESPONSE_SIGNING_KEY_ID is required in ${deploymentMode()} mode`);
  }

  for (const flag of MOCK_FLAGS) {
    if (process.env[flag] === '1') {
      errors.push(`${flag}=1 is not allowed in ${deploymentMode()} mode`);
    }
  }

  // Not a mock flag, but the same category of development convenience: it
  // disables operator authentication outright. A strict deployment running
  // with this set has an unauthenticated console, and #90's wallet roster
  // becomes decorative.
  if (process.env.PAXIOM_DISABLE_AUTH === '1') {
    errors.push(
      `PAXIOM_DISABLE_AUTH=1 disables operator authentication entirely and is not allowed in ${deploymentMode()} mode`,
    );
  }

  if (process.env.REQUIRE_X402 === '1') {
    if (!process.env.X402_FACILITATOR_URL) {
      errors.push(`X402_FACILITATOR_URL is required when REQUIRE_X402=1 in ${deploymentMode()} mode`);
    }
    if (!process.env.X402_DESTINATION || /^0x0{40}$/i.test(process.env.X402_DESTINATION)) {
      errors.push(`X402_DESTINATION must be a non-zero settlement address when REQUIRE_X402=1 in ${deploymentMode()} mode`);
    }
  } else {
    warnings.push('REQUIRE_X402 is not enabled; payment metadata will be emitted as verified:false/settled:false');
  }

  if (service === 'sync-committee' && process.env.BLS_DEVICE_VIA_SUBPROCESS === '1') {
    const harness = process.env.BLS_DEVICE_HARNESS || '/usr/local/bin/bls-device-harness';
    try {
      accessSync(harness, constants.X_OK);
    } catch {
      errors.push(`BLS_DEVICE_HARNESS is not executable: ${harness}`);
    }
  }

  if (PROOF_ARCHIVE_SERVICES.has(service)) {
    const mode = String(process.env.PAXIOM_PROOF_ARCHIVE_MODE || 'disabled').toLowerCase();
    if (!['local', 'arweave'].includes(mode)) {
      errors.push(`PAXIOM_PROOF_ARCHIVE_MODE must be local or arweave for ${service} in ${deploymentMode()} mode`);
    }
    if (!process.env.PAXIOM_PROOF_ARCHIVE_ENCRYPTION_KEY_BASE64) {
      errors.push(`PAXIOM_PROOF_ARCHIVE_ENCRYPTION_KEY_BASE64 is required for ${service} in ${deploymentMode()} mode`);
    }
    if (
      (mode === 'arweave' || process.env.PAXIOM_AO_PROOF_ARCHIVE_PROCESS) &&
      !process.env.PAXIOM_ARWEAVE_WALLET_JWK &&
      !process.env.PAXIOM_ARWEAVE_WALLET_JWK_PATH
    ) {
      errors.push(`PAXIOM_ARWEAVE_WALLET_JWK or PAXIOM_ARWEAVE_WALLET_JWK_PATH is required for Arweave/AO proof archive writes`);
    }
  }

  if (REFERENCE_SERVICE_BLOCKERS[service] && process.env.PAXIOM_ALLOW_REFERENCE_SERVICES !== '1') {
    errors.push(`${REFERENCE_SERVICE_BLOCKERS[service]} (set PAXIOM_ALLOW_REFERENCE_SERVICES=1 to deploy with explicit reference status)`);
  }

  return {
    ok: errors.length === 0,
    mode: deploymentMode(),
    errors,
    warnings,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const service = process.argv[2] || '';
    const result = preflightService(service);
    for (const warning of result.warnings) console.error(`WARN: ${warning}`);
    if (!result.ok) {
      for (const error of result.errors) console.error(`FATAL: ${error}`);
      process.exit(78);
    }
  } catch (e) {
    console.error(`FATAL: ${e.message}`);
    process.exit(78);
  }
}
