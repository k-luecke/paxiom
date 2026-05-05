// HTTP front-end for Service A-202 - Sync Committee Verification.
// Owns POST /v1/sync-committee/verify per O-701 / S.02.

import { createServer } from 'node:http';
import { dispatch } from './dispatch.mjs';
import { validateRequest } from './schema.mjs';
import { readJsonBody, sendJson, methodNotAllowed, notFound } from '../shared/http.mjs';
import { createServiceEnvelope } from '../shared/envelope.mjs';
import { requirePayment, paymentResponseHeaders } from '../shared/x402.mjs';

const PORT = Number(process.env.SYNC_COMMITTEE_PORT || 8080);
const HOST = process.env.SYNC_COMMITTEE_HOST || '127.0.0.1';

async function handleVerify(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);

  let body;
  try {
    body = await readJsonBody(req);
  } catch (e) {
    return sendJson(res, 400, { error: 'invalid json', detail: String(e) });
  }

  const validationError = validateRequest(body);
  if (validationError) {
    return sendJson(res, 400, { error: 'invalid request', detail: validationError });
  }

  const paid = await requirePayment(req, res, {
    service: 'A-202',
    resource: '/v1/sync-committee/verify',
  });
  if (!paid.ok) return;

  let response;
  try {
    response = await dispatch(body);
  } catch (e) {
    return sendJson(res, 502, { error: 'dispatch failed', detail: String(e) });
  }

  const envelope = createServiceEnvelope({
    service: 'A-202',
    serviceName: 'Sync Committee Verification',
    artifactType: 'sync_committee_verification',
    payload: response,
    payment: paid.payment,
    audit: {
      status: response.ao_message_id?.startsWith('mock-') ? 'mock_record' : 'device_recorded',
      aoMessageId: response.ao_message_id,
      evidenceTags: ['service:A-202', `slot:${response.slot}`],
    },
  });

  return sendJson(res, 200, envelope, paymentResponseHeaders(paid.payment, { correlation: response.ao_message_id }));
}

export function createApp() {
  return createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname === '/v1/sync-committee/verify') return handleVerify(req, res);
    if (url.pathname === '/healthz') return sendJson(res, 200, { ok: true, service: 'A-202' });
    return notFound(res);
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (process.env.MOCK_DEVICE === '1' && process.env.PAXIOM_ALLOW_MOCK !== '1') {
    console.error('FATAL: MOCK_DEVICE=1 requires PAXIOM_ALLOW_MOCK=1.');
    console.error('Mock dispatch returns verified=false and stamps payload.mock=true,');
    console.error('but production deployments must NOT run with MOCK_DEVICE=1.');
    console.error('Set PAXIOM_ALLOW_MOCK=1 in dev/CI to acknowledge.');
    process.exit(1);
  }
  const server = createApp();
  server.listen(PORT, HOST, () => {
    console.log(`sync-committee service listening on http://${HOST}:${PORT}`);
    console.log('  POST /v1/sync-committee/verify');
    console.log('  GET  /healthz');
    if (process.env.MOCK_DEVICE === '1') {
      console.log('  MOCK_DEVICE=1 - responses are synthesised; payload.verified=false, payload.mock=true');
    }
  });
}
