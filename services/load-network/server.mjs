import { createServer } from 'node:http';
import { LoadNetworkClient } from '../../load-network/client.mjs';
import { ErigonProofClient } from '../../load-network/erigon-client.mjs';
import { reconstructAccountState, reconstructStorageSlot } from '../../load-network/reconstruct.mjs';
import { readJsonBody, sendJson, methodNotAllowed, notFound } from '../shared/http.mjs';
import { requirePayment, paymentResponseHeaders } from '../shared/x402.mjs';
import { fixtureFetch } from './fixture-client.mjs';

const PORT = Number(process.env.LOAD_NETWORK_SERVICE_PORT || 8081);
const HOST = process.env.LOAD_NETWORK_SERVICE_HOST || '127.0.0.1';

export function createApp({ client } = {}) {
  const stateClient = client || defaultClient();
  return createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname === '/healthz') {
      return sendJson(res, 200, { ok: true, service: 'R-200' });
    }
    if (url.pathname === '/v1/load-network/reconstruct/account') {
      if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
      return handleAccount(req, res, stateClient, url.pathname);
    }
    if (url.pathname === '/v1/load-network/reconstruct/storage') {
      if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
      return handleStorage(req, res, stateClient, url.pathname);
    }
    return notFound(res);
  });
}

async function handleAccount(req, res, client, resource) {
  const paid = await requirePayment(req, res, { service: 'R-200', resource });
  if (!paid.ok) return;
  try {
    const body = await readJsonBody(req);
    const result = await reconstructAccountState({
      blockNumber: body.blockNumber,
      address: body.address,
      client,
    });
    return sendJson(res, 200, result, paymentResponseHeaders(paid.payment, { correlation: result.block_hash }));
  } catch (e) {
    return sendJson(res, errorStatus(e), { error: e.name || 'LoadNetworkError', detail: e.message });
  }
}

async function handleStorage(req, res, client, resource) {
  const paid = await requirePayment(req, res, { service: 'R-200', resource });
  if (!paid.ok) return;
  try {
    const body = await readJsonBody(req);
    const result = await reconstructStorageSlot({
      blockNumber: body.blockNumber,
      address: body.address,
      slot: body.slot,
      client,
    });
    return sendJson(res, 200, result, paymentResponseHeaders(paid.payment, { correlation: result.block_hash }));
  } catch (e) {
    return sendJson(res, errorStatus(e), { error: e.name || 'LoadNetworkError', detail: e.message });
  }
}

function defaultClient() {
  if (process.env.MOCK_LOAD_NETWORK === '1') {
    assertNotStrictMode('MOCK_LOAD_NETWORK fixture client', 'MOCK_LOAD_NETWORK');
    return new LoadNetworkClient({ fetchImpl: fixtureFetch() });
  }
  if (process.env.PAXIOM_STATE_SOURCE === 'erigon') {
    return new ErigonProofClient();
  }
  return new LoadNetworkClient();
}

function errorStatus(e) {
  if (e.name === 'LoadNetworkProtocolError') return 502;
  if (e.name === 'LoadNetworkVerificationError') return 422;
  if (e.name === 'LoadNetworkDataError') return 400;
  return 502;
}

// Audit M-05 / M-14: fixtureFetch was duplicated here and in
// services/load-network/fixture-client.mjs. Consolidated to the
// shared module; this duplicate plus its readFixture/jsonResponse
// helpers (now imported transitively) are removed.

if (import.meta.url === `file://${process.argv[1]}`) {
  createApp().listen(PORT, HOST, () => {
    console.log(`load-network service listening on http://${HOST}:${PORT}`);
  });
}
