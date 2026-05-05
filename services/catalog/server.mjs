import { createServer } from 'node:http';
import { phase1Catalog } from './phase1.mjs';
import { sendJson, notFound } from '../shared/http.mjs';

const PORT = Number(process.env.SERVICE_CATALOG_PORT || 8090);
const HOST = process.env.SERVICE_CATALOG_HOST || '127.0.0.1';

export function createApp() {
  return createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname === '/healthz') return sendJson(res, 200, { ok: true, service: 'CATALOG' });
    if (url.pathname === '/.well-known/paxiom-services.json') return sendJson(res, 200, phase1Catalog());
    if (url.pathname === '/v1/services') return sendJson(res, 200, phase1Catalog());
    return notFound(res);
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  createApp().listen(PORT, HOST, () => {
    console.log(`service catalog listening on http://${HOST}:${PORT}`);
  });
}
