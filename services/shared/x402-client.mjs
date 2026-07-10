// x402 buyer client — turns a 402 "payment required" challenge into a signed
// X-PAYMENT header using the exact (EIP-3009 transferWithAuthorization) scheme.
//
// No new dependencies: signing is done with viem (already vendored) directly
// from a LocalAccount, so no RPC is required to produce a payment. An optional
// public client can cross-check the on-chain EIP-712 domain before signing.
//
// CLI:  PRIVATE_KEY=... node services/shared/x402-client.mjs <url> [jsonBody]
import { randomBytes } from 'node:crypto';
import { toHex } from 'viem';
import { decodeHeader, X402_VERSION } from './x402.mjs';

export const NETWORK_CHAIN_IDS = {
  'base-sepolia': 84532,
  base: 8453,
  'ethereum-sepolia': 11155111,
  ethereum: 1,
};

const TRANSFER_WITH_AUTHORIZATION_TYPES = {
  TransferWithAuthorization: [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
  ],
};

function chainIdFor(network) {
  const id = NETWORK_CHAIN_IDS[network];
  if (!id) throw new Error(`x402-client: unknown network "${network}"`);
  return id;
}

/**
 * Build and sign the x402 payment payload for a single challenge.
 * @param {object} challenge  paymentRequirements from the 402 response
 * @param {object} account    viem LocalAccount (privateKeyToAccount)
 * @param {object} [opts]     { nowSeconds?: number }
 * @returns {Promise<{payload: object, header: string, authorization: object}>}
 */
export async function buildPayment(challenge, account, opts = {}) {
  if (!challenge) throw new Error('x402-client: missing challenge');
  const { network, asset, payTo, maxAmountRequired, maxTimeoutSeconds = 300, extra } = challenge;
  if (!asset || !/^0x[0-9a-fA-F]{40}$/.test(asset)) {
    throw new Error(`x402-client: challenge.asset must be a token contract address, got "${asset}"`);
  }
  if (!payTo || /^0x0{40}$/.test(payTo)) {
    throw new Error('x402-client: challenge.payTo is missing or the zero address');
  }
  const domainName = extra?.name;
  const domainVersion = extra?.version;
  if (!domainName || !domainVersion) {
    throw new Error('x402-client: challenge.extra.{name,version} (EIP-712 domain) required for exact scheme');
  }

  const now = opts.nowSeconds ?? Math.floor(Date.now() / 1000);
  const authorization = {
    from: account.address,
    to: payTo,
    value: BigInt(maxAmountRequired),
    validAfter: BigInt(now - 60), // small backdate to tolerate clock skew
    validBefore: BigInt(now + Number(maxTimeoutSeconds)),
    nonce: toHex(randomBytes(32)),
  };

  const domain = {
    name: domainName,
    version: domainVersion,
    chainId: chainIdFor(network),
    verifyingContract: asset,
  };

  const signature = await account.signTypedData({
    domain,
    types: TRANSFER_WITH_AUTHORIZATION_TYPES,
    primaryType: 'TransferWithAuthorization',
    message: authorization,
  });

  // Facilitators expect JSON-serialisable values, so stringify the bigints.
  const wireAuthorization = {
    from: authorization.from,
    to: authorization.to,
    value: authorization.value.toString(),
    validAfter: authorization.validAfter.toString(),
    validBefore: authorization.validBefore.toString(),
    nonce: authorization.nonce,
  };

  const payload = {
    x402Version: X402_VERSION,
    scheme: 'exact',
    network,
    payload: { signature, authorization: wireAuthorization },
  };

  const header = Buffer.from(JSON.stringify(payload)).toString('base64');
  return { payload, header, authorization: wireAuthorization };
}

/**
 * fetch() wrapper that transparently satisfies an x402 402 challenge and retries.
 * @param {string} url
 * @param {object} init      standard fetch init
 * @param {object} account   viem LocalAccount
 * @returns {Promise<{response: Response, paid: boolean, receipt: object|null, payment: object|null}>}
 */
export async function x402Fetch(url, init, account) {
  const first = await fetch(url, init);
  if (first.status !== 402) {
    return { response: first, paid: false, receipt: null, payment: null };
  }

  const challenge = await extractChallenge(first);
  const { header, payload } = await buildPayment(challenge, account);

  const retryInit = { ...init, headers: { ...(init.headers || {}), 'X-PAYMENT': header } };
  const paidResp = await fetch(url, retryInit);
  const receipt = decodeReceipt(paidResp);
  return { response: paidResp, paid: true, receipt, payment: payload, challenge };
}

async function extractChallenge(resp) {
  // Prefer the PAYMENT-REQUIRED header, fall back to the JSON body.
  const headerVal = resp.headers.get('payment-required') || resp.headers.get('x-payment-required');
  const fromHeader = decodeHeader(headerVal);
  if (fromHeader) return fromHeader;
  const body = await resp.json().catch(() => null);
  if (body?.payment_required) return body.payment_required;
  throw new Error('x402-client: 402 response carried no payment_required challenge');
}

function decodeReceipt(resp) {
  const val = resp.headers.get('payment-response') || resp.headers.get('x-payment-response');
  return decodeHeader(val);
}

// ---- CLI ----
if (import.meta.url === `file://${process.argv[1]}`) {
  const { privateKeyToAccount } = await import('viem/accounts');
  const url = process.argv[2];
  const body = process.argv[3];
  if (!url) {
    console.error('usage: PRIVATE_KEY=... node services/shared/x402-client.mjs <url> [jsonBody]');
    process.exit(1);
  }
  const pk = process.env.PRIVATE_KEY;
  if (!pk) {
    console.error('ERROR: PRIVATE_KEY not set');
    process.exit(1);
  }
  const account = privateKeyToAccount(`0x${pk.replace(/^0x/, '')}`);
  const init = {
    method: process.env.X402_METHOD || (body ? 'POST' : 'GET'),
    headers: { 'Content-Type': 'application/json' },
    body: body ?? undefined,
  };
  const { response, paid, receipt } = await x402Fetch(url, init, account);
  const text = await response.text();
  console.log(JSON.stringify({
    payer: account.address,
    status: response.status,
    paid,
    receipt,
    body: safeJson(text),
  }, null, 2));
  process.exit(response.ok ? 0 : 1);
}

function safeJson(text) {
  try { return JSON.parse(text); } catch { return text; }
}
