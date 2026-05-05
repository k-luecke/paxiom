import { createServer } from 'node:http';
import {
  createArbEngineState,
  evaluateOpportunity,
  recordEvaluation,
  startEngine,
  stopEngine,
} from '../../engine/arb-engine.mjs';
import { readJsonBody, sendJson, methodNotAllowed, notFound } from '../shared/http.mjs';
import { requirePayment, paymentResponseHeaders } from '../shared/x402.mjs';

const PORT = Number(process.env.ARB_ENGINE_PORT || 8082);
const HOST = process.env.ARB_ENGINE_HOST || '127.0.0.1';

export function createApp({ state = createArbEngineState() } = {}) {
  return createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname === '/healthz') return sendJson(res, 200, { ok: true, service: 'ARB-001' });
    if (url.pathname === '/v1/arb/status') return sendJson(res, 200, { service: 'ARB-001', ...state });
    if (url.pathname === '/v1/arb/run') {
      if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
      startEngine(state);
      return sendJson(res, 200, { service: 'ARB-001', ...state });
    }
    if (url.pathname === '/v1/arb/stop') {
      if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
      stopEngine(state);
      return sendJson(res, 200, { service: 'ARB-001', ...state });
    }
    if (url.pathname === '/v1/arb/evaluate') {
      if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
      return handleEvaluate(req, res, state, url.pathname);
    }
    return notFound(res);
  });
}

async function handleEvaluate(req, res, state, resource) {
  const paid = await requirePayment(req, res, { service: 'ARB-001', resource });
  if (!paid.ok) return;
  try {
    const body = await readJsonBody(req);
    const evaluation = evaluateOpportunity(body);
    recordEvaluation(state, evaluation);
    return sendJson(
      res,
      200,
      evaluation,
      paymentResponseHeaders(paid.payment, { correlation: evaluation.opportunity.id }),
    );
  } catch (e) {
    return sendJson(res, 400, { error: 'invalid opportunity', detail: e.message });
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  createApp().listen(PORT, HOST, () => {
    console.log(`arb-engine service listening on http://${HOST}:${PORT}`);
  });
}
