import { createServer } from 'node:http';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { complianceProfile, classifyEvent, summarizeEvents } from '../../compliance/profile.mjs';
import { readJsonBody, sendJson, methodNotAllowed, notFound } from '../shared/http.mjs';
import { requirePayment, paymentResponseHeaders } from '../shared/x402.mjs';

const PORT = Number(process.env.COMPLIANCE_SERVICE_PORT || 8083);
const HOST = process.env.COMPLIANCE_SERVICE_HOST || '127.0.0.1';

export function createApp({ events = loadInitialEvents() } = {}) {
  return createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname === '/healthz') return sendJson(res, 200, { ok: true, service: complianceProfile.service });
    if (url.pathname === '/v1/compliance/profile') return sendJson(res, 200, complianceProfile);
    if (url.pathname === '/v1/compliance/report') {
      return sendJson(res, 200, { profile: complianceProfile, summary: summarizeEvents(events), events });
    }
    if (url.pathname === '/v1/compliance/events') {
      if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
      return handleEvent(req, res, events, url.pathname);
    }
    return notFound(res);
  });
}

async function handleEvent(req, res, events, resource) {
  const paid = await requirePayment(req, res, { service: complianceProfile.service, resource });
  if (!paid.ok) return;
  try {
    const body = await readJsonBody(req);
    const event = normalizeEvent(body);
    const classification = classifyEvent(event);
    events.push(event);
    persistEvent(event);
    return sendJson(
      res,
      201,
      { event, classification },
      paymentResponseHeaders(paid.payment, { correlation: event.event_id }),
    );
  } catch (e) {
    return sendJson(res, 400, { error: 'invalid compliance event', detail: e.message });
  }
}

function normalizeEvent(input) {
  if (!input || typeof input !== 'object') throw new Error('event must be an object');
  if (!input.event_type) throw new Error('event_type is required');
  if (!input.source_service) throw new Error('source_service is required');
  return {
    event_id: input.event_id || `paxiom-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    recorded_at: input.recorded_at || new Date().toISOString(),
    jurisdiction: input.jurisdiction || 'US',
    regulatory_context: input.regulatory_context || [
      'CFTC GMAC Digital Asset Markets Subcommittee',
      'GDF/ISDA U.S. TMMF Working Group',
    ],
    ...input,
  };
}

function loadInitialEvents() {
  const file = process.env.COMPLIANCE_LOG_FILE;
  if (!file || !existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function persistEvent(event) {
  if (!process.env.COMPLIANCE_LOG_FILE) return;
  appendFileSync(process.env.COMPLIANCE_LOG_FILE, JSON.stringify(event) + '\n');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  createApp().listen(PORT, HOST, () => {
    console.log(`compliance service listening on http://${HOST}:${PORT}`);
  });
}
