import { createServer } from 'node:http';
import { simulateTransaction } from './simulator.mjs';
import { readJsonBody, sendJson, methodNotAllowed, notFound } from '../shared/http.mjs';
import { createServiceEnvelope } from '../shared/envelope.mjs';
import { requirePayment, paymentResponseHeaders } from '../shared/x402.mjs';

const PORT = Number(process.env.SIMULATION_SERVICE_PORT || 8094);
const HOST = process.env.SIMULATION_SERVICE_HOST || '127.0.0.1';

export function createApp() {
  return createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname === '/healthz') return sendJson(res, 200, { ok: true, service: 'A-204' });
    if (url.pathname !== '/v1/simulations') return notFound(res);
    if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
    return handleSimulation(req, res, url.pathname);
  });
}

async function handleSimulation(req, res, resource) {
  const paid = await requirePayment(req, res, { service: 'A-204', resource });
  if (!paid.ok) return;
  try {
    const body = await readJsonBody(req);
    const receipt = simulateTransaction(body);
    const envelope = createServiceEnvelope({
      service: 'A-204',
      serviceName: 'Simulation as a Service',
      artifactType: 'simulation_receipt',
      payload: receipt,
      payment: paid.payment,
      audit: {
        status: 'pending_write',
        evidenceTags: ['service:A-204', `chain:${receipt.chain}`, `simulation:${receipt.simulation_id}`],
      },
    });
    return sendJson(res, 200, envelope, paymentResponseHeaders(paid.payment, { correlation: receipt.simulation_id }));
  } catch (e) {
    return sendJson(res, 400, { error: 'SimulationError', detail: e.message });
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  createApp().listen(PORT, HOST, () => {
    console.log(`A-204 simulation service listening on http://${HOST}:${PORT}`);
  });
}
