import { createServer } from 'node:http';
import { LoadNetworkClient } from '../../load-network/client.mjs';
import { ErigonProofClient } from '../../load-network/erigon-client.mjs';
import { reconstructAccountState, reconstructStorageSlot } from '../../load-network/reconstruct.mjs';
import { readJsonBody, sendJson, methodNotAllowed, notFound } from '../shared/http.mjs';
import { createServiceEnvelope } from '../shared/envelope.mjs';
import { requirePayment, paymentResponseHeaders } from '../shared/x402.mjs';
import { fixtureFetch } from '../load-network/fixture-client.mjs';
import { assertNotStrictMode } from '../shared/deployment.mjs';
import { archiveEvidence } from '../shared/proof-archive.mjs';

const PORT = Number(process.env.HISTORICAL_STATE_PORT || 8095);
const HOST = process.env.HISTORICAL_STATE_HOST || '127.0.0.1';

export function createApp({ client } = {}) {
  const stateClient = client || defaultClient();
  return createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname === '/healthz') return sendJson(res, 200, { ok: true, service: 'A-205' });
    if (url.pathname !== '/v1/historical-state/query') return notFound(res);
    if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
    return handleQuery(req, res, stateClient, url.pathname);
  });
}

async function handleQuery(req, res, client, resource) {
  const paid = await requirePayment(req, res, { service: 'A-205', resource });
  if (!paid.ok) return;
  try {
    const body = await readJsonBody(req);
    const result = body.slot
      ? await reconstructStorageSlot({ blockNumber: body.blockNumber, address: body.address, slot: body.slot, client })
      : await reconstructAccountState({ blockNumber: body.blockNumber, address: body.address, client });
    const artifactType = body.slot ? 'verified_historical_storage_state' : 'verified_historical_account_state';
    const evidenceTags = ['service:A-205', `block:${result.block_number}`, `address:${result.address}`];
    if (result.slot) evidenceTags.push(`slot:${result.slot}`);
    const audit = await archiveEvidence({
      service: 'A-205',
      artifactType,
      payload: result,
      request: {
        blockNumber: body.blockNumber,
        address: body.address,
        slot: body.slot || null,
      },
      evidenceTags,
    });
    const envelope = createServiceEnvelope({
      service: 'A-205',
      serviceName: 'Verified Historical State',
      artifactType,
      payment: paid.payment,
      audit,
      payload: result,
    });
    return sendJson(res, 200, envelope, paymentResponseHeaders(paid.payment, { correlation: result.block_hash }));
  } catch (e) {
    return sendJson(res, errorStatus(e), { error: e.name || 'HistoricalStateError', detail: e.message });
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
  if (e.name === 'LoadNetworkVerificationError') return 422;
  if (e.name === 'LoadNetworkDataError') return 400;
  return 502;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  createApp().listen(PORT, HOST, () => {
    console.log(`A-205 historical-state service listening on http://${HOST}:${PORT}`);
  });
}
