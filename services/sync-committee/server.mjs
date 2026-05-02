// HTTP front-end for Service A-202 — Sync Committee Verification.
// Owns POST /v1/sync-committee/verify per O-701 / S.02.
//
// Designed to run with zero external npm dependencies (uses node:http and
// the package's existing @permaweb/aoconnect for the AO compliance write).
// `dispatch.mjs` calls into HyperBEAM via fetch, into a local Rust harness
// via subprocess, or into a deterministic mock — selectable by env.

import { createServer } from 'node:http';
import { dispatch } from './dispatch.mjs';
import { validateRequest } from './schema.mjs';

const PORT = Number(process.env.SYNC_COMMITTEE_PORT || 8080);
const HOST = process.env.SYNC_COMMITTEE_HOST || '127.0.0.1';

async function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('error', reject);
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

function jsonResponse(res, status, body) {
  const buf = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': buf.length,
  });
  res.end(buf);
}

async function handleVerify(req, res) {
  if (req.method !== 'POST') {
    res.writeHead(405, { Allow: 'POST' });
    res.end();
    return;
  }
  let body;
  try {
    body = JSON.parse(await readBody(req));
  } catch (e) {
    return jsonResponse(res, 400, { error: 'invalid json', detail: String(e) });
  }
  const validationError = validateRequest(body);
  if (validationError) {
    return jsonResponse(res, 400, { error: 'invalid request', detail: validationError });
  }

  // x402 verification stub — real impl checks the X-PAYMENT header against
  // the Coinbase facilitator. For Phase 0 the stub accepts everything.
  const paymentHeader = req.headers['x-payment'] || '';
  if (process.env.REQUIRE_X402 === '1' && !paymentHeader) {
    res.writeHead(402);
    res.end();
    return;
  }

  let response;
  try {
    response = await dispatch(body);
  } catch (e) {
    return jsonResponse(res, 502, { error: 'dispatch failed', detail: String(e) });
  }

  // The HyperBEAM device already invoked the AO compliance hook; the service
  // layer doesn't double-write. We do echo the message id back via the
  // X-PAYMENT-RESPONSE-CORRELATION header for x402 conformance.
  res.setHeader('X-PAYMENT-RESPONSE-CORRELATION', response.ao_message_id);
  return jsonResponse(res, 200, response);
}

export function createApp() {
  return createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname === '/v1/sync-committee/verify') {
      return handleVerify(req, res);
    }
    if (url.pathname === '/healthz') {
      return jsonResponse(res, 200, { ok: true, service: 'A-202' });
    }
    res.writeHead(404);
    res.end();
  });
}

// Start the server when this file is run directly (not when imported).
if (import.meta.url === `file://${process.argv[1]}`) {
  const server = createApp();
  server.listen(PORT, HOST, () => {
    console.log(`sync-committee service listening on http://${HOST}:${PORT}`);
    console.log(`  POST /v1/sync-committee/verify`);
    console.log(`  GET  /healthz`);
    if (process.env.MOCK_DEVICE === '1') {
      console.log(`  MOCK_DEVICE=1 — responses are synthesised, not verified`);
    }
  });
}
