import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  assertSafeX402Runtime,
  loadX402Config,
} from '../x402-config.mjs';

const configuredSigner = { ephemeral: false };
const ephemeralSigner = { ephemeral: true };

function paidEnv(overrides = {}) {
  return {
    REQUIRE_X402: '1',
    MOCK_DEVICE: '',
    X402_MODE: 'testnet',
    X402_PAY_TO: '0x0000000000000000000000000000000000000001',
    X402_FACILITATOR_URL: 'https://x402.org/facilitator',
    PAXIOM_PLATFORM_SIGNING_KEY: 'configured-for-test',
    ...overrides,
  };
}

test('paid mode refuses MOCK_DEVICE, including production boot shape', () => {
  const env = paidEnv({ NODE_ENV: 'production', MOCK_DEVICE: '1' });
  assert.throws(
    () => assertSafeX402Runtime(loadX402Config(env), env, configuredSigner),
    /never charge for MOCK_DEVICE/,
  );
});

test('paid mode refuses a missing receiving wallet', () => {
  const env = paidEnv({ X402_PAY_TO: '', PAXIOM_RECEIVING_WALLET: '' });
  assert.throws(
    () => assertSafeX402Runtime(loadX402Config(env), env, configuredSigner),
    /valid 20-byte EVM address/,
  );
});

test('paid mode refuses an invalid facilitator URL', () => {
  const env = paidEnv({ X402_FACILITATOR_URL: 'not-a-url' });
  assert.throws(
    () => assertSafeX402Runtime(loadX402Config(env), env, configuredSigner),
    /valid http\(s\) URL/,
  );
});

test('paid mode refuses an ephemeral platform key unless explicitly allowed', () => {
  const env = paidEnv({ PAXIOM_PLATFORM_SIGNING_KEY: '' });
  assert.throws(
    () => assertSafeX402Runtime(loadX402Config(env), env, ephemeralSigner),
    /requires PAXIOM_PLATFORM_SIGNING_KEY/,
  );
});

test('local tests may explicitly allow an ephemeral platform key', () => {
  const env = paidEnv({
    PAXIOM_PLATFORM_SIGNING_KEY: '',
    PAXIOM_ALLOW_EPHEMERAL_PLATFORM_KEY: '1',
  });
  assert.doesNotThrow(() => assertSafeX402Runtime(loadX402Config(env), env, ephemeralSigner));
});
