/**
 * Independent HTTP Message Router for Networked Distributed WASM Runner (C95-AO-00B).
 *
 * Implements an asynchronous HTTP/JSON transport between addressed processes:
 * - Assigns unique Process IDs
 * - Tracks message IDs (msg-xxxx), timestamps, and message audit logs
 * - Provides non-blocking inboxes and message delivery
 */

import http from 'node:http';
import url from 'node:url';

const inboxes = new Map(); // processId -> Array of messages
const waiters = new Map(); // processId -> Array of resolve functions
const messageLog = [];
let msgCounter = 0;

function generateMsgId() {
  return `msg-${Date.now()}-${String(++msgCounter).padStart(6, '0')}`;
}

export function createRouterServer(port = 8765) {
  const server = http.createServer(async (req, res) => {
    const parsed = url.parse(req.url, true);
    const path = parsed.pathname;

    if (req.method === 'POST' && path === '/send') {
      let body = '';
      for await (const chunk of req) body += chunk;
      let msg;
      try {
        msg = JSON.parse(body);
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'invalid json' }));
      }

      const msgId = msg.id || generateMsgId();
      const enrichedMsg = {
        id: msgId,
        from: msg.from,
        target: msg.target,
        action: msg.action,
        data: msg.data || {},
        timestamp: Date.now(),
        bytes: Buffer.byteLength(body),
      };

      messageLog.push(enrichedMsg);

      const target = msg.target;
      if (waiters.has(target) && waiters.get(target).length > 0) {
        const resolve = waiters.get(target).shift();
        resolve(enrichedMsg);
      } else {
        if (!inboxes.has(target)) inboxes.set(target, []);
        inboxes.get(target).push(enrichedMsg);
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, id: msgId }));
    } else if (req.method === 'GET' && path.startsWith('/poll/')) {
      const processId = path.slice('/poll/'.length);
      const queue = inboxes.get(processId) || [];

      if (queue.length > 0) {
        const msg = queue.shift();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: true, message: msg }));
      }

      // Long poll for up to 5000ms
      const timeout = setTimeout(() => {
        if (waiters.has(processId)) {
          const list = waiters.get(processId).filter((fn) => fn !== onMsg);
          waiters.set(processId, list);
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, timeout: true }));
      }, 5000);

      const onMsg = (msg) => {
        clearTimeout(timeout);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, message: msg }));
      };

      if (!waiters.has(processId)) waiters.set(processId, []);
      waiters.get(processId).push(onMsg);
    } else if (req.method === 'GET' && path === '/audit') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ total_messages: messageLog.length, messages: messageLog }));
    } else if (req.method === 'POST' && path === '/clear') {
      inboxes.clear();
      waiters.clear();
      messageLog.length = 0;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    } else {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
    }
  });

  server.keepAliveTimeout = 120000;
  server.headersTimeout = 125000;

  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      resolve(server);
    });
  });
}

// Standalone entrypoint if run directly
if (process.argv[1] && process.argv[1].endsWith('network_router.mjs')) {
  const port = Number(process.env.ROUTER_PORT || 8765);
  createRouterServer(port).then(() => {
    console.log(`AO Network Transport Router listening on http://127.0.0.1:${port}`);
  });
}
