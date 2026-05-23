import { createHash, randomUUID } from 'node:crypto';
import { isStrictDeployment, deploymentMode } from './deployment.mjs';

const DEFAULT_DESTINATION = '0x0000000000000000000000000000000000000000';
const DEFAULT_NETWORK = 'base-sepolia';
const DEFAULT_ASSET = 'USDC';

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
  return {
    x402Version: 2,
    scheme: 'exact',
    network,
    asset,
    maxAmountRequired: amount,
    payTo: destination,
    resource,
    description: `Paxiom ${service} paid API access`,
    mimeType: 'application/json',
    outputSchema: { type: 'object' },
    expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
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
    const payment = await verifyWithFacilitator(signature, cfg);
    if (!payment.verified) {
      const required = createPaymentRequired(cfg);
      res.writeHead(402, { 'PAYMENT-REQUIRED': encodeHeader(required) });
      res.end(JSON.stringify({ error: 'payment verification failed', payment_required: required }));
      return { ok: false };
    }
    return { ok: true, payment };
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
    x402Version: 2,
    receiptId: payment?.receiptId || randomUUID(),
    verified: payment?.verified !== false,
    mode: payment?.mode || 'unknown',
    settled: payment?.settled === true,
    correlation: extra.correlation,
  };
  const encoded = encodeHeader(receipt);
  return {
    'PAYMENT-RESPONSE': encoded,
    'X-PAYMENT-RESPONSE': encoded,
    'X-PAYMENT-RESPONSE-CORRELATION': extra.correlation || receipt.receiptId,
  };
}

async function verifyWithFacilitator(signature, cfg) {
  const base = process.env.X402_FACILITATOR_URL.replace(/\/+$/, '');
  const resp = await fetch(`${base}/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      paymentPayload: signature,
      paymentRequirements: createPaymentRequired(cfg),
    }),
  });
  if (!resp.ok) {
    return { mode: 'facilitator', verified: false, status: resp.status };
  }
  const body = await resp.json();
  return {
    mode: 'facilitator',
    verified: body.verified === true || body.isValid === true,
    settlementRequired: true,
    facilitator: body,
    receiptId: body.receiptId || body.transactionHash,
  };
}
