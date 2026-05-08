// Paxiom local verifier service (MVP).
//
// One narrow vertical slice:
//   request -> deterministic verification -> audit log -> signed receipt -> replayable
//
// Endpoints:
//   GET  /health
//   POST /verify
//   GET  /receipts/:id
//   GET  /replay/:id    (returns the replay command and verification result)
//   GET  /pubkey        (PEM public key for offline verification)

import { createServer } from 'node:http';
import { readJsonBody, sendJson, methodNotAllowed, notFound } from '../shared/http.mjs';
import { buildReceipt, signReceipt, verifyReceiptSignature, SERVICE_NAME } from './lib/receipt.mjs';
import { createStore } from './lib/store.mjs';
import { loadOrCreateKeypair } from './lib/keys.mjs';
import { resolveDataDir, resolveKeyPaths } from './lib/paths.mjs';
import { getVerifier, listVerifiers, resolveVerifierId, DEFAULT_VERIFIER_ID } from './lib/registry.mjs';

const REPLAY_COMMAND_TEMPLATE = 'node services/local-verifier/scripts/replay.mjs {receipt_id}';

export function createApp({ dataDir = resolveDataDir() } = {}) {
  const store = createStore(dataDir);
  const { privatePath, publicPath } = resolveKeyPaths(dataDir);
  const keypair = loadOrCreateKeypair(privatePath, publicPath);

  const handleHealth = (res) => sendJson(res, 200, {
    ok: true,
    service: SERVICE_NAME,
    default_verifier: DEFAULT_VERIFIER_ID,
    verifiers: listVerifiers(),
    data_dir: dataDir,
  });

  const handlePubkey = (res) => sendJson(res, 200, {
    algorithm: 'ed25519',
    public_key_pem: keypair.publicPem,
  });

  const handleListVerifiers = (res) => sendJson(res, 200, {
    default: DEFAULT_VERIFIER_ID,
    verifiers: listVerifiers(),
  });

  async function handleVerify(req, res) {
    if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
    let body;
    try {
      body = await readJsonBody(req);
    } catch (e) {
      return sendJson(res, 400, { error: 'invalid json', detail: String(e) });
    }

    const verifierId = resolveVerifierId(body);
    const entry = getVerifier(verifierId);
    if (!entry) {
      return sendJson(res, 400, {
        error: 'unknown verifier',
        verifier: verifierId,
        available: listVerifiers().map((v) => v.id),
      });
    }

    const result = entry.verify(body);
    if (result.invalid) {
      return sendJson(res, 400, { error: 'invalid request', detail: result.reason });
    }
    const core = buildReceipt({
      verifierName: entry.name,
      verifierVersion: entry.version,
      decision: result.decision,
      reason: result.reason,
      inputHash: result.input_hash,
      outputHash: result.output_hash,
      priorReceiptHash: store.lastReceiptHash(),
      replayCommandTemplate: REPLAY_COMMAND_TEMPLATE,
    });
    const signed = signReceipt(core, keypair.privateKey, keypair.publicPem);
    store.persist(signed);
    return sendJson(res, result.decision === 'pass' ? 200 : 422, {
      receipt: signed,
      details: result.details,
    });
  }

  function handleGetReceipt(res, id) {
    const receipt = store.load(id);
    if (!receipt) return sendJson(res, 404, { error: 'receipt not found', receipt_id: id });
    return sendJson(res, 200, receipt);
  }

  function handleReplay(res, id) {
    const receipt = store.load(id);
    if (!receipt) return sendJson(res, 404, { error: 'receipt not found', receipt_id: id });
    const check = verifyReceiptSignature(receipt, keypair.publicKey);
    return sendJson(res, 200, {
      receipt_id: id,
      replay_command: receipt.replay_command,
      hash_recomputed: check.recomputedHash,
      hash_matches: check.ok || check.recomputedHash === (receipt.receipt_hash || '').replace(/^0x/, ''),
      signature_valid: check.ok,
      reason: check.reason || null,
    });
  }

  return createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const { pathname } = url;
    if (pathname === '/health') return sendJson(res, 200, { ok: true });
    if (pathname === '/healthz') return handleHealth(res);
    if (pathname === '/pubkey') return handlePubkey(res);
    if (pathname === '/verifiers') return handleListVerifiers(res);
    if (pathname === '/verify') return handleVerify(req, res);

    const receiptMatch = pathname.match(/^\/receipts\/([A-Za-z0-9_-]+)$/);
    if (receiptMatch) {
      if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);
      return handleGetReceipt(res, receiptMatch[1]);
    }
    const replayMatch = pathname.match(/^\/replay\/([A-Za-z0-9_-]+)$/);
    if (replayMatch) {
      if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);
      return handleReplay(res, replayMatch[1]);
    }
    return notFound(res);
  });
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const port = Number(process.env.LOCAL_VERIFIER_PORT || 3000);
  const host = process.env.LOCAL_VERIFIER_HOST || '127.0.0.1';
  const app = createApp();
  app.listen(port, host, () => {
    console.log(`paxiom-local-verifier listening on http://${host}:${port}`);
    console.log('  GET  /health');
    console.log('  POST /verify');
    console.log('  GET  /receipts/:id');
    console.log('  GET  /replay/:id');
    console.log('  GET  /pubkey');
    console.log('  GET  /verifiers');
    console.log(`default verifier: ${DEFAULT_VERIFIER_ID}`);
    for (const v of listVerifiers()) console.log(`  - ${v.id} (v${v.version})`);
  });
}
