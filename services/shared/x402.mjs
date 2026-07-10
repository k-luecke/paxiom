import { createHash, randomUUID } from 'node:crypto';
import { isStrictDeployment, deploymentMode } from './deployment.mjs';

const DEFAULT_DESTINATION = '0x0000000000000000000000000000000000000000';
const DEFAULT_NETWORK = 'base-sepolia';
const DEFAULT_ASSET = 'USDC';

// x402 protocol version carried on the wire. The public x402.org facilitator
// pairs EVM `base-sepolia` with version 1 (verified against /supported); the
// newer version-2 EVM path uses CAIP-2 network ids. Default to 1 for
// facilitator compatibility; override with X402_PROTOCOL_VERSION.
export const X402_VERSION = Number(process.env.X402_PROTOCOL_VERSION || 1);

// Human-readable list prices (USD). Converted to atomic units at challenge time
// using the resolved asset's decimals so the on-wire maxAmountRequired is
// x402-facilitator-compatible.
const PRICE_BY_SERVICE = {
  'A-201': '1.00',
  'A-202': '0.50',
  'A-203': '3.00',
  'A-204': '0.05',
  'A-205': '2.00',
  'R-200': '0.02',
  'ARB-001': '0.01',
  'COMPLIANCE-001': '0.01',
};

// Per-network token registry. `name`/`version` are the on-chain EIP-712 domain
// fields (verified against the deployed contract) that the exact-scheme
// authorization is signed over; the facilitator re-derives the same domain.
const ASSET_REGISTRY = {
  'base-sepolia': {
    USDC: { address: '0x036CbD53842c5426634e7929541eC2318f3dCF7e', decimals: 6, eip712: { name: 'USDC', version: '2' } },
  },
  base: {
    USDC: { address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', decimals: 6, eip712: { name: 'USDC', version: '2' } },
  },
};

export function resolveAsset(network, symbol) {
  const net = ASSET_REGISTRY[network];
  const token = net && net[symbol];
  if (!token) return null;
  // Env overrides let an operator point at a different deployment without code.
  return {
    symbol,
    address: process.env.X402_ASSET_ADDRESS || token.address,
    decimals: Number(process.env.X402_ASSET_DECIMALS || token.decimals),
    eip712: {
      name: process.env.X402_ASSET_EIP712_NAME || token.eip712.name,
      version: process.env.X402_ASSET_EIP712_VERSION || token.eip712.version,
    },
  };
}

export function toAtomic(amountDecimal, decimals) {
  const [whole, frac = ''] = String(amountDecimal).split('.');
  const fracPadded = (frac + '0'.repeat(decimals)).slice(0, decimals);
  return (BigInt(whole || '0') * 10n ** BigInt(decimals) + BigInt(fracPadded || '0')).toString();
}

export function paymentSignatureFrom(req) {
  return req.headers['payment-signature'] || req.headers['x-payment'] || '';
}

export function createPaymentRequired({
  service,
  resource,
  amount = PRICE_BY_SERVICE[service] || '0.01',
  asset = process.env.X402_ASSET || DEFAULT_ASSET,
  network = process.env.X402_NETWORK || DEFAULT_NETWORK,
  destination = process.env.X402_DESTINATION || DEFAULT_DESTINATION,
} = {}) {
  const token = resolveAsset(network, asset);
  const decimals = token ? token.decimals : 6;
  return {
    x402Version: X402_VERSION,
    scheme: 'exact',
    network,
    // Wire field: token CONTRACT ADDRESS in atomic units, per the x402 exact
    // scheme. `assetSymbol`/`priceUSD` are kept as human-readable annotations.
    asset: token ? token.address : asset,
    assetSymbol: asset,
    priceUSD: amount,
    maxAmountRequired: toAtomic(amount, decimals),
    payTo: destination,
    resource,
    description: `Paxiom ${service} paid API access`,
    mimeType: 'application/json',
    outputSchema: { type: 'object' },
    maxTimeoutSeconds: 300,
    expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
    extra: token ? { name: token.eip712.name, version: token.eip712.version } : undefined,
  };
}

export function encodeHeader(obj) {
  return Buffer.from(JSON.stringify(obj)).toString('base64');
}

export function decodeHeader(value) {
  if (!value) return null;
  try {
    return JSON.parse(Buffer.from(value, 'base64').toString('utf8'));
  } catch {
    return null;
  }
}

export async function requirePayment(req, res, cfg) {
  if (process.env.REQUIRE_X402 !== '1') {
    return {
      ok: true,
      payment: { mode: 'disabled', verified: false, settled: false, settlementRequired: false },
    };
  }

  const signature = paymentSignatureFrom(req);
  if (!signature) {
    const required = createPaymentRequired(cfg);
    const encoded = encodeHeader(required);
    res.writeHead(402, {
      'Content-Type': 'application/json',
      'PAYMENT-REQUIRED': encoded,
      'X-PAYMENT-REQUIRED': encoded,
    });
    res.end(JSON.stringify({ error: 'payment required', payment_required: required }));
    return { ok: false };
  }

  if (process.env.X402_FACILITATOR_URL) {
    const required = createPaymentRequired(cfg);
    const payment = await verifyWithFacilitator(signature, required);
    if (!payment.verified) {
      res.writeHead(402, { 'PAYMENT-REQUIRED': encodeHeader(required) });
      res.end(JSON.stringify({ error: 'payment verification failed', payment_required: required }));
      return { ok: false };
    }

    // Verification only proves the signed authorization is valid; the funds are
    // not moved until the facilitator broadcasts the on-chain settlement. We
    // settle up front (before serving) so a served response always corresponds
    // to a settled payment. If settlement fails, fall back to 402.
    const settlement = await settleWithFacilitator(signature, required);
    if (!settlement.settled) {
      res.writeHead(402, { 'PAYMENT-REQUIRED': encodeHeader(required) });
      res.end(JSON.stringify({ error: 'payment settlement failed', detail: settlement.error, payment_required: required }));
      return { ok: false };
    }

    return { ok: true, payment: { ...payment, ...settlement } };
  }

  if (isStrictDeployment()) {
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      error: 'x402 facilitator unavailable',
      detail: `X402_FACILITATOR_URL is required in ${deploymentMode()} mode`,
    }));
    return { ok: false };
  }

  if (process.env.PAXIOM_ALLOW_LOCAL_X402 !== '1') {
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      error: 'x402 local verifier disabled',
      detail: 'Set X402_FACILITATOR_URL for settlement verification or PAXIOM_ALLOW_LOCAL_X402=1 for local development.',
    }));
    return { ok: false };
  }

  const payload = decodeHeader(signature);
  const requestHash = createHash('sha256')
    .update(signature)
    .update(cfg?.resource || req.url || '')
    .digest('hex');

  return {
    ok: true,
    payment: {
      mode: 'local-header',
      verified: false,
      settled: false,
      settlementRequired: false,
      payload,
      receiptId: `local-x402-${requestHash.slice(0, 16)}`,
    },
  };
}

export function paymentResponseHeaders(payment, extra = {}) {
  const receipt = {
    x402Version: X402_VERSION,
    receiptId: payment?.receiptId || randomUUID(),
    verified: payment?.verified !== false,
    mode: payment?.mode || 'unknown',
    settled: payment?.settled === true,
    settled_tx: payment?.settled_tx,
    network: payment?.network,
    correlation: extra.correlation,
  };
  const encoded = encodeHeader(receipt);
  return {
    'PAYMENT-RESPONSE': encoded,
    'X-PAYMENT-RESPONSE': encoded,
    'X-PAYMENT-RESPONSE-CORRELATION': extra.correlation || receipt.receiptId,
  };
}

function facilitatorPayload(signature, required) {
  // The X-PAYMENT header carries the base64-encoded x402 payment payload. The
  // facilitator expects the decoded JSON object; pass it through decoded when we
  // can, otherwise forward the raw string and let the facilitator decode.
  return {
    x402Version: X402_VERSION,
    paymentPayload: decodeHeader(signature) || signature,
    paymentRequirements: required,
  };
}

async function verifyWithFacilitator(signature, required) {
  const base = process.env.X402_FACILITATOR_URL.replace(/\/+$/, '');
  let body;
  try {
    const resp = await fetch(`${base}/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(facilitatorPayload(signature, required)),
    });
    if (!resp.ok) {
      return { mode: 'facilitator', verified: false, status: resp.status };
    }
    body = await resp.json();
  } catch (e) {
    return { mode: 'facilitator', verified: false, error: e.message };
  }
  return {
    mode: 'facilitator',
    verified: body.isValid === true || body.verified === true,
    settlementRequired: true,
    payer: body.payer,
    facilitator: body,
  };
}

async function settleWithFacilitator(signature, required) {
  const base = process.env.X402_FACILITATOR_URL.replace(/\/+$/, '');
  let body;
  try {
    const resp = await fetch(`${base}/settle`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(facilitatorPayload(signature, required)),
    });
    body = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      return { settled: false, status: resp.status, error: body.error || body.errorReason || `settle ${resp.status}` };
    }
  } catch (e) {
    return { settled: false, error: e.message };
  }
  const settled = body.success === true || body.settled === true;
  const txHash = body.transaction || body.txHash || body.transactionHash;
  return {
    settled,
    settled_tx: txHash,
    network: body.network,
    payer: body.payer,
    receiptId: txHash,
    error: settled ? undefined : (body.error || body.errorReason || 'settlement not confirmed'),
    settlement: body,
  };
}
