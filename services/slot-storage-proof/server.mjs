import { createServer } from 'node:http';
import { LoadNetworkClient } from '../../load-network/client.mjs';
import { ErigonProofClient } from '../../load-network/erigon-client.mjs';
import { reconstructStorageSlot } from '../../load-network/reconstruct.mjs';
import { readJsonBody, sendJson, methodNotAllowed, notFound } from '../shared/http.mjs';
import { createServiceEnvelope } from '../shared/envelope.mjs';
import { requirePayment, paymentResponseHeaders } from '../shared/x402.mjs';
import { fixtureFetch } from '../load-network/fixture-client.mjs';
import { assertNotStrictMode } from '../shared/deployment.mjs';
import { archiveEvidence } from '../shared/proof-archive.mjs';

const PORT = Number(process.env.SLOT_STORAGE_PROOF_PORT || 8091);
const HOST = process.env.SLOT_STORAGE_PROOF_HOST || '127.0.0.1';

export function createApp({ client } = {}) {
  const stateClient = client || defaultClient();
  return createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname === '/healthz') return sendJson(res, 200, { ok: true, service: 'A-201' });
    if (url.pathname !== '/v1/slot-storage-proofs') return notFound(res);
    if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
    return handleProof(req, res, stateClient, url.pathname);
  });
}

async function handleProof(req, res, client, resource) {
  const paid = await requirePayment(req, res, { service: 'A-201', resource });
  if (!paid.ok) return;
  try {
    const body = await readJsonBody(req);
    const proof = await reconstructStorageSlot({
      blockNumber: body.blockNumber,
      address: body.address,
      slot: body.slot,
      client,
    });
    const payload = {
      verified: proof.verified,
      block_number: proof.block_number,
      block_hash: proof.block_hash,
      state_root: proof.state_root,
      address: proof.address,
      storage_root: proof.storage_root,
      slot: proof.slot,
      value: proof.value,
      source: proof.source,
      archive_root: proof.archive_root,
      witness: proof.witness,
      zk_proof: {
        status: 'not_generated_in_reference_service',
        note: 'MPT witness packet is ready for the Service 01 ZK circuit.',
      },
    };
    const evidenceTags = ['service:A-201', `block:${proof.block_number}`, `address:${proof.address}`, `slot:${proof.slot}`];
    const audit = await archiveEvidence({
      service: 'A-201',
      artifactType: 'slot_storage_proof_packet',
      payload,
      request: {
        blockNumber: body.blockNumber,
        address: body.address,
        slot: body.slot,
      },
      evidenceTags,
    });
    const envelope = createServiceEnvelope({
      service: 'A-201',
      serviceName: 'Slot Storage Proofs',
      artifactType: 'slot_storage_proof_packet',
      payment: paid.payment,
      audit,
      payload,
    });
    return sendJson(res, 200, envelope, paymentResponseHeaders(paid.payment, { correlation: proof.block_hash }));
  } catch (e) {
    return sendJson(res, errorStatus(e), { error: e.name || 'SlotStorageProofError', detail: e.message });
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
    console.log(`A-201 slot-storage-proof service listening on http://${HOST}:${PORT}`);
  });
}
