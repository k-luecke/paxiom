// Local mock x402 facilitator — for OFFLINE proof of the verify -> settle loop
// without spending real testnet USDC. It performs the SAME EIP-712 signature
// recovery a real facilitator does on /verify, but /settle only SIMULATES the
// on-chain broadcast (returns a deterministic pseudo tx hash). Never point a
// production deployment at this; it moves no funds.
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { recoverTypedDataAddress, getAddress } from 'viem';
import { NETWORK_CHAIN_IDS } from '../services/shared/x402-client.mjs';

const PORT = Number(process.env.MOCK_FACILITATOR_PORT || 8099);
const HOST = process.env.MOCK_FACILITATOR_HOST || '127.0.0.1';

const TYPES = {
  TransferWithAuthorization: [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
  ],
};

async function validate({ paymentPayload, paymentRequirements }) {
  if (!paymentPayload || !paymentRequirements) {
    return { ok: false, reason: 'missing paymentPayload or paymentRequirements' };
  }
  const inner = paymentPayload.payload || paymentPayload;
  const { signature, authorization } = inner;
  if (!signature || !authorization) {
    return { ok: false, reason: 'payload missing signature/authorization' };
  }

  const network = paymentPayload.network || paymentRequirements.network;
  const chainId = NETWORK_CHAIN_IDS[network];
  if (!chainId) return { ok: false, reason: `unknown network ${network}` };

  const domain = {
    name: paymentRequirements.extra?.name,
    version: paymentRequirements.extra?.version,
    chainId,
    verifyingContract: paymentRequirements.asset,
  };
  if (!domain.name || !domain.version || !domain.verifyingContract) {
    return { ok: false, reason: 'paymentRequirements missing asset/extra domain' };
  }

  const message = {
    from: authorization.from,
    to: authorization.to,
    value: BigInt(authorization.value),
    validAfter: BigInt(authorization.validAfter),
    validBefore: BigInt(authorization.validBefore),
    nonce: authorization.nonce,
  };

  let recovered;
  try {
    recovered = await recoverTypedDataAddress({
      domain,
      types: TYPES,
      primaryType: 'TransferWithAuthorization',
      message,
      signature,
    });
  } catch (e) {
    return { ok: false, reason: `signature recovery failed: ${e.shortMessage || e.message}` };
  }

  if (getAddress(recovered) !== getAddress(authorization.from)) {
    return { ok: false, reason: 'signature does not match authorization.from' };
  }
  if (getAddress(authorization.to) !== getAddress(paymentRequirements.payTo)) {
    return { ok: false, reason: 'authorization.to does not match payTo' };
  }
  if (BigInt(authorization.value) < BigInt(paymentRequirements.maxAmountRequired)) {
    return { ok: false, reason: 'authorized value below maxAmountRequired' };
  }
  const now = BigInt(Math.floor(Date.now() / 1000));
  if (BigInt(authorization.validBefore) <= now) return { ok: false, reason: 'authorization expired' };
  if (BigInt(authorization.validAfter) > now) return { ok: false, reason: 'authorization not yet valid' };

  return { ok: true, payer: getAddress(authorization.from), authorization };
}

function simulatedTxHash(authorization) {
  // Deterministic pseudo hash from the (unique) authorization nonce + from.
  const h = createHash('sha256')
    .update(authorization.nonce)
    .update(authorization.from)
    .update(authorization.value)
    .digest('hex');
  return `0x${h}`;
}

function send(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

export function createApp() {
  return createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/healthz') {
      return send(res, 200, { ok: true, facilitator: 'mock', warning: 'simulated settlement — moves no funds' });
    }
    if (req.method === 'GET' && req.url === '/supported') {
      return send(res, 200, { kinds: [{ scheme: 'exact', network: 'base-sepolia' }] });
    }
    if (req.method !== 'POST') return send(res, 405, { error: 'method not allowed' });

    let payload;
    try { payload = await readBody(req); } catch { return send(res, 400, { error: 'bad json' }); }

    if (req.url === '/verify') {
      const v = await validate(payload);
      return send(res, 200, v.ok ? { isValid: true, payer: v.payer } : { isValid: false, invalidReason: v.reason });
    }
    if (req.url === '/settle') {
      const v = await validate(payload);
      if (!v.ok) return send(res, 200, { success: false, errorReason: v.reason });
      return send(res, 200, {
        success: true,
        transaction: simulatedTxHash(v.authorization),
        network: payload.paymentPayload?.network || payload.paymentRequirements?.network,
        payer: v.payer,
        simulated: true,
      });
    }
    return send(res, 404, { error: 'not found' });
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  createApp().listen(PORT, HOST, () => {
    console.log(`[mock-facilitator] listening on http://${HOST}:${PORT} (SIMULATED settlement — no real funds move)`);
  });
}
