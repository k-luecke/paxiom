import { randomUUID } from 'node:crypto';

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

let x402GateChecked = false;
function assertX402Configured() {
  if (x402GateChecked) return;
  if (!process.env.X402_FACILITATOR_URL) {
    throw new Error(
      'x402 misconfiguration: REQUIRE_X402=1 but X402_FACILITATOR_URL is unset. ' +
      'Refusing to serve paid endpoints without a real verifier (audit H-02, issue #13).',
    );
  }
  x402GateChecked = true;
}

export async function requirePayment(req, res, cfg) {
  if (process.env.REQUIRE_X402 !== '1') {
    return {
      ok: true,
      payment: { mode: 'disabled', verified: true, settlementRequired: false },
    };
  }

  assertX402Configured();

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

  const payment = await verifyWithFacilitator(signature, cfg);
  // Billable gate: the authorization must verify AND, unless settlement is
  // explicitly opted out, the on-chain capture must succeed. Otherwise we'd
  // hand over the product without ever collecting the funds.
  const settledOk =
    !payment.settlementRequired || payment.settled || process.env.X402_SETTLE === '0';
  if (!payment.verified || !settledOk) {
    const required = createPaymentRequired(cfg);
    res.writeHead(402, { 'PAYMENT-REQUIRED': encodeHeader(required) });
    res.end(JSON.stringify({
      error: payment.verified ? 'payment settlement failed' : 'payment verification failed',
      reason: payment.reason,
      payment_required: required,
    }));
    return { ok: false };
  }
  return { ok: true, payment };
}

export function paymentResponseHeaders(payment, extra = {}) {
  const receipt = {
    x402Version: 2,
    receiptId: payment?.receiptId || randomUUID(),
    verified: payment?.verified !== false,
    mode: payment?.mode || 'unknown',
    settled: payment?.settled === true,
    transaction: payment?.transaction,
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

function facilitatorAuthHeaders() {
  // Public testnet facilitators (e.g. x402.org) need no auth; the Coinbase
  // CDP mainnet facilitator requires a bearer token.
  const key = process.env.X402_FACILITATOR_API_KEY;
  return key ? { Authorization: `Bearer ${key}` } : {};
}

async function facilitatorPost(url, payload) {
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...facilitatorAuthHeaders() },
    body: JSON.stringify(payload),
  });
}

// Runs the two-step x402 facilitator flow: /verify validates the signed
// payment authorization, then /settle submits the on-chain transfer that
// actually captures the funds. Verifying without settling means the customer
// proved they *could* pay but no money moved — so settlement is what makes
// the endpoint billable.
async function verifyWithFacilitator(signature, cfg) {
  const base = process.env.X402_FACILITATOR_URL.replace(/\/+$/, '');
  const requirements = createPaymentRequired(cfg);
  // The X-PAYMENT header is base64(JSON) per x402; facilitators expect the
  // decoded PaymentPayload object. Fall back to the raw value if it isn't
  // base64 JSON (keeps simpler/test payloads working).
  const paymentPayload = decodeHeader(signature) ?? signature;
  const requestBody = { x402Version: 2, paymentPayload, paymentRequirements: requirements };

  // Step 1 — verify the authorization.
  let verifyBody;
  try {
    const resp = await facilitatorPost(`${base}/verify`, requestBody);
    if (!resp.ok) {
      return { mode: 'facilitator', verified: false, settled: false, status: resp.status, reason: 'verify_http_error' };
    }
    verifyBody = await resp.json();
  } catch (e) {
    return { mode: 'facilitator', verified: false, settled: false, reason: `verify_error: ${e.message}` };
  }
  const valid = verifyBody.isValid === true || verifyBody.verified === true;
  if (!valid) {
    return {
      mode: 'facilitator', verified: false, settled: false,
      reason: verifyBody.invalidReason || 'authorization_invalid', facilitator: { verify: verifyBody },
    };
  }

  // Verify-only opt-out (smoke tests / dry runs): authorization is valid but
  // we deliberately don't move money.
  if (process.env.X402_SETTLE === '0') {
    return {
      mode: 'facilitator', verified: true, settled: false, settlementRequired: true,
      payer: verifyBody.payer, facilitator: { verify: verifyBody },
    };
  }

  // Step 2 — settle on-chain to capture the funds.
  let settleBody;
  try {
    const resp = await facilitatorPost(`${base}/settle`, requestBody);
    if (!resp.ok) {
      return { mode: 'facilitator', verified: true, settled: false, settlementRequired: true, status: resp.status, reason: 'settle_http_error', payer: verifyBody.payer };
    }
    settleBody = await resp.json();
  } catch (e) {
    return { mode: 'facilitator', verified: true, settled: false, settlementRequired: true, reason: `settle_error: ${e.message}`, payer: verifyBody.payer };
  }
  const settled = settleBody.success === true;
  const txHash = settleBody.transaction || settleBody.txHash || settleBody.transactionHash;
  return {
    mode: 'facilitator',
    verified: true,
    settled,
    settlementRequired: true,
    transaction: txHash,
    network: settleBody.network || requirements.network,
    payer: settleBody.payer || verifyBody.payer,
    receiptId: txHash || verifyBody.receiptId,
    reason: settled ? undefined : (settleBody.errorReason || 'settlement_unsuccessful'),
    facilitator: { verify: verifyBody, settle: settleBody },
  };
}
