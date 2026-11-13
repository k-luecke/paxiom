const BASE_SEPOLIA = 'eip155:84532';
const BASE_MAINNET = 'eip155:8453';
const HOSTED_FACILITATOR_URL = 'https://x402.org/facilitator';

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

function boolEnv(value, defaultValue = false) {
  if (value == null || value === '') return defaultValue;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

function inferMode(env) {
  if (env.X402_MODE) return env.X402_MODE;
  if (env.X402_NETWORK === BASE_MAINNET) return 'mainnet';
  return 'testnet';
}

function defaultPrice(mode) {
  return mode === 'mainnet' ? '$0.01' : '$0.001';
}

function defaultNetwork(mode) {
  return mode === 'mainnet' ? BASE_MAINNET : BASE_SEPOLIA;
}

function nodeVersionAtLeast(major, minor) {
  const [actualMajor, actualMinor] = process.versions.node.split('.').map(Number);
  return actualMajor > major || (actualMajor === major && actualMinor >= minor);
}

function isHttpUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch (_e) {
    return false;
  }
}

export function loadX402Config(env = process.env) {
  const mode = inferMode(env);
  const network = env.X402_NETWORK || defaultNetwork(mode);
  const price = env.X402_PRICE || env.SYNC_COMMITTEE_PRICE || defaultPrice(mode);
  const payTo = env.X402_PAY_TO || env.PAXIOM_RECEIVING_WALLET || '';

  return {
    enabled: boolEnv(env.REQUIRE_X402),
    mode,
    network,
    price,
    payTo,
    facilitatorUrl: env.X402_FACILITATOR_URL || HOSTED_FACILITATOR_URL,
    publicBaseUrl: (env.PUBLIC_BASE_URL || `http://${env.SYNC_COMMITTEE_HOST || '127.0.0.1'}:${env.SYNC_COMMITTEE_PORT || 8080}`).replace(/\/+$/, ''),
    maxTimeoutSeconds: Number(env.X402_MAX_TIMEOUT_SECONDS || 120),
    syncFacilitatorOnStart: boolEnv(env.X402_SYNC_FACILITATOR_ON_START, true),
    evidenceDir: env.SYNC_COMMITTEE_EVIDENCE_DIR || 'hyperbeam/bringup/evidence',
    evidenceDisabled: boolEnv(env.DISABLE_SYNC_COMMITTEE_EVIDENCE),
    nodeSupportedForProduction: nodeVersionAtLeast(20, 19),
    version: env.PAXIOM_SERVICE_VERSION || env.GIT_SHA || 'dev',
    allowEphemeralPlatformKey: boolEnv(env.PAXIOM_ALLOW_EPHEMERAL_PLATFORM_KEY),
  };
}

export function assertSafeX402Runtime(cfg, env = process.env, signer = null) {
  if (!cfg.enabled) return;

  if (env.MOCK_DEVICE === '1') {
    throw new Error('REQUIRE_X402=1 cannot be combined with MOCK_DEVICE=1; never charge for MOCK_DEVICE responses');
  }
  if (!ADDRESS_RE.test(cfg.payTo)) {
    throw new Error('X402_PAY_TO or PAXIOM_RECEIVING_WALLET must be a valid 20-byte EVM address when REQUIRE_X402=1');
  }
  if (!isHttpUrl(cfg.facilitatorUrl)) {
    throw new Error('X402_FACILITATOR_URL must be a valid http(s) URL when REQUIRE_X402=1');
  }
  if (cfg.mode === 'mainnet' && cfg.network !== BASE_MAINNET) {
    throw new Error(`X402_MODE=mainnet must use ${BASE_MAINNET}; got ${cfg.network}`);
  }
  if (cfg.mode === 'testnet' && cfg.network !== BASE_SEPOLIA) {
    throw new Error(`X402_MODE=testnet must use ${BASE_SEPOLIA}; got ${cfg.network}`);
  }
  if (env.NODE_ENV === 'production' && !cfg.nodeSupportedForProduction) {
    throw new Error('Production x402 mode requires Node >=20.19.0 because the installed x402 stack declares that engine floor');
  }
  if (signer?.ephemeral && !cfg.allowEphemeralPlatformKey) {
    throw new Error('REQUIRE_X402=1 requires PAXIOM_PLATFORM_SIGNING_KEY or PAXIOM_PLATFORM_PRIVATE_KEY_PEM; set PAXIOM_ALLOW_EPHEMERAL_PLATFORM_KEY=1 only for local tests');
  }
}

export function buildPaymentRouteConfig(cfg) {
  return {
    accepts: {
      scheme: 'exact',
      network: cfg.network,
      price: cfg.price,
      payTo: cfg.payTo,
      maxTimeoutSeconds: cfg.maxTimeoutSeconds,
    },
    resource: `${cfg.publicBaseUrl}/v1/sync-committee/verify`,
    description: 'Paxiom A-202 sync committee verification: verify an Ethereum beacon sync-committee aggregate and return a replayable evidence handle.',
    mimeType: 'application/json',
    unpaidResponseBody: () => ({
      contentType: 'application/json',
      body: {
        error: 'payment_required',
        service: 'A-202',
        price: cfg.price,
        network: cfg.network,
        facilitator_url: cfg.facilitatorUrl,
        accepted_headers: ['PAYMENT-SIGNATURE'],
      },
    }),
    settlementFailedResponseBody: (_context, failure) => ({
      contentType: 'application/json',
      body: {
        error: 'settlement_failed',
        service: 'A-202',
        reason: failure.errorReason,
        message: failure.errorMessage,
      },
    }),
  };
}
