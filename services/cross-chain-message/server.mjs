import { createServer } from 'node:http';
import { verifyMessageEvidence } from './verifier.mjs';
import { readJsonBody, sendJson, methodNotAllowed, notFound } from '../shared/http.mjs';
import { createServiceEnvelope } from '../shared/envelope.mjs';
import { requirePayment, paymentResponseHeaders } from '../shared/x402.mjs';

const PORT = Number(process.env.CROSS_CHAIN_MESSAGE_PORT || 8093);
const HOST = process.env.CROSS_CHAIN_MESSAGE_HOST || '127.0.0.1';

export function createApp() {
  return createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname === '/healthz') return sendJson(res, 200, { ok: true, service: 'A-203' });
    if (url.pathname !== '/v1/cross-chain-messages/verify') return notFound(res);
    if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
    return handleVerify(req, res, url.pathname);
  });
}

async function handleVerify(req, res, resource) {
  const paid = await requirePayment(req, res, { service: 'A-203', resource });
  if (!paid.ok) return;
  try {
    const body = await readJsonBody(req);
    const attestation = verifyMessageEvidence(body);
    const envelope = createServiceEnvelope({
      service: 'A-203',
      serviceName: 'Cross-Chain Message Verification',
      // Audit M-12: artifact name made explicit. The verifier returns
      // verified=false until the bridge-grade source/target proof
      // integration lands; "attestation" oversold the shape.
      artifactType: 'cross_chain_message_evidence_request',
      payload: attestation,
      payment: paid.payment,
      audit: {
        status: 'pending_write',
        evidenceTags: ['service:A-203', `source:${attestation.evidence.sourceChain}`, `target:${attestation.evidence.targetChain}`],
      },
    });
    return sendJson(res, 200, envelope, paymentResponseHeaders(paid.payment, { correlation: attestation.attestation_id }));
  } catch (e) {
    return sendJson(res, 400, { error: 'CrossChainMessageVerificationError', detail: e.message });
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  createApp().listen(PORT, HOST, () => {
    console.log(`A-203 cross-chain-message service listening on http://${HOST}:${PORT}`);
  });
}
