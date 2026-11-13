// HTTP front-end for Service A-202 - Sync Committee Verification.
// Owns POST /v1/sync-committee/verify per O-701 / S.02.

import express from 'express';
import { HTTPFacilitatorClient, x402ResourceServer } from '@x402/core/server';
import { paymentMiddlewareFromHTTPServer, x402HTTPResourceServer } from '@x402/express';
import { registerExactEvmScheme } from '@x402/evm/exact/server';
import { dispatch } from './dispatch.mjs';
import { requestSchema, responseSchema, validateRequest } from './schema.mjs';
import {
  assertSafeX402Runtime,
  buildPaymentRouteConfig,
  loadX402Config,
} from './x402-config.mjs';
import { writeComputationEvidence, writeSettlementEvidence } from './evidence.mjs';
import { classifyDispatchOutcome } from './x402-gate.mjs';
import {
  buildSignedPayload,
  loadPlatformSigner,
  signPayload,
} from './platform-signature.mjs';
import { mcpMetadata } from './mcp-metadata.mjs';

const PORT = Number(process.env.SYNC_COMMITTEE_PORT || 8080);
const HOST = process.env.SYNC_COMMITTEE_HOST || '127.0.0.1';

function dispatchMode() {
  if (process.env.MOCK_DEVICE === '1') return 'mock';
  if (process.env.BLS_DEVICE_VIA_SUBPROCESS === '1') return 'subprocess';
  return 'hyperbeam';
}

function paymentMiddleware(cfg, facilitatorClient) {
  const resourceServer = new x402ResourceServer(
    facilitatorClient || new HTTPFacilitatorClient({ url: cfg.facilitatorUrl }),
  );
  registerExactEvmScheme(resourceServer, { networks: [cfg.network] });
  resourceServer.onAfterSettle(async (context) => {
    await writeSettlementEvidence({ cfg, context });
  });

  const httpServer = new x402HTTPResourceServer(resourceServer, {
    'POST /v1/sync-committee/verify': buildPaymentRouteConfig(cfg),
  });
  const buildSettlementFailureResponse = httpServer.buildSettlementFailureResponse.bind(httpServer);
  httpServer.buildSettlementFailureResponse = async (...args) => ({
    ...(await buildSettlementFailureResponse(...args)),
    status: 502,
  });

  return paymentMiddlewareFromHTTPServer(
    httpServer,
    { appName: 'Paxiom A-202', testnet: cfg.mode !== 'mainnet' },
    undefined,
    cfg.syncFacilitatorOnStart,
  );
}

async function handleVerify(req, res) {
  const validationError = validateRequest(req.body);
  if (validationError) {
    return res.status(400).json({ error: 'invalid request', detail: validationError });
  }

  let response;
  try {
    response = await req.app.locals.dispatch(req.body);
  } catch (e) {
    return res.status(502).json({ error: 'dispatch failed', detail: String(e) });
  }

  const outcome = classifyDispatchOutcome(response);
  if (!outcome.settle) {
    return res.status(outcome.httpStatus).json({
      error: outcome.class,
      detail: outcome.error,
      service: 'A-202',
    });
  }

  let evidencePacket = null;
  try {
    evidencePacket = await writeComputationEvidence({
      cfg: req.app.locals.x402,
      request: req.body,
      response,
      dispatchMode: dispatchMode(),
    });
  } catch (e) {
    return res.status(500).json({ error: 'evidence write failed', detail: String(e) });
  }

  if (response.ao_message_id) {
    res.setHeader('X-PAXIOM-RESPONSE-CORRELATION', response.ao_message_id);
  }
  if (evidencePacket) {
    res.setHeader('X-PAXIOM-EVIDENCE-PACKET', evidencePacket);
  }

  const signedPayload = buildSignedPayload({
    request: req.body,
    response,
    evidenceId: evidencePacket,
    version: req.app.locals.x402.version,
  });
  const signature = signPayload({
    signer: req.app.locals.platformSigner,
    payload: signedPayload,
  });

  res.setHeader('X-PAXIOM-SIGNATURE', signature.signatureBase64);
  res.setHeader('X-PAXIOM-SIGNED-PAYLOAD-HASH', signature.signedPayloadHash);
  res.setHeader('X-PAXIOM-KEY-ID', req.app.locals.platformSigner.keyId);
  return res.status(200).json({
    ...response,
    evidence_packet: evidencePacket,
    signed_payload: signature.signedPayload,
    platform_signature: signature.signatureBase64,
    platform_signature_alg: 'ed25519',
    platform_key_id: req.app.locals.platformSigner.keyId,
    signed_payload_hash: signature.signedPayloadHash,
  });
}

export function createApp(options = {}) {
  const env = options.env || process.env;
  const cfg = options.x402 || loadX402Config(env);
  const platformSigner = options.platformSigner || loadPlatformSigner(env);
  assertSafeX402Runtime(cfg, env, platformSigner);

  const app = express();
  app.disable('x-powered-by');
  app.locals.x402 = cfg;
  app.locals.dispatch = options.dispatch || dispatch;
  app.locals.platformSigner = platformSigner;
  app.use(express.json({ limit: '128kb' }));

  app.get('/healthz', (_req, res) => res.status(200).json({
    ok: true,
    service: 'A-202',
    x402: {
      enabled: cfg.enabled,
      mode: cfg.mode,
      network: cfg.network,
      price: cfg.price,
      node_supported_for_production: cfg.nodeSupportedForProduction,
    },
    dispatch: dispatchMode(),
    platform_signer: {
      alg: platformSigner.alg,
      key_id: platformSigner.keyId,
      ephemeral: platformSigner.ephemeral,
    },
  }));

  app.get('/.well-known/paxiom-platform-pubkey.json', (_req, res) => res.status(200).json(
    platformSigner.publicKeyDocument,
  ));

  app.get('/mcp/tools.json', (_req, res) => res.status(200).json({
    tools: [mcpMetadata(cfg)],
  }));

  app.get('/mcp/paxiom-sync-committee.json', (_req, res) => res.status(200).json({
    ...mcpMetadata(cfg),
    input_schema: requestSchema,
    output_schema: responseSchema,
  }));

  if (cfg.enabled) {
    app.use(paymentMiddleware(cfg, options.facilitatorClient));
  }

  app.post('/v1/sync-committee/verify', handleVerify);
  app.all('/v1/sync-committee/verify', (_req, res) => {
    res.setHeader('Allow', 'POST');
    return res.status(405).end();
  });

  app.use((_req, res) => res.status(404).end());
  return app;
}

// Start the server when this file is run directly (not when imported).
if (import.meta.url === `file://${process.argv[1]}`) {
  const app = createApp();
  const cfg = app.locals.x402;
  const server = app.listen(PORT, HOST, () => {
    console.log(`sync-committee service listening on http://${HOST}:${PORT}`);
    console.log('  POST /v1/sync-committee/verify');
    console.log('  GET  /healthz');
    console.log('  GET  /mcp/tools.json');
    console.log(`  x402 ${cfg.enabled ? 'enabled' : 'disabled'} (${cfg.mode}, ${cfg.network}, ${cfg.price})`);
    if (process.env.MOCK_DEVICE === '1') {
      console.log('  MOCK_DEVICE=1 - responses are synthesised, not billable');
    }
    if (process.env.BLS_DEVICE_VIA_SUBPROCESS === '1') {
      console.log('  BLS_DEVICE_VIA_SUBPROCESS=1 - using local harness first');
    }
  });
}
