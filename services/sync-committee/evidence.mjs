import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { canonicalJson, requestHash, sha256Hex } from './platform-signature.mjs';

function timestamp() {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

function evidencePath(cfg, prefix, slot, hash) {
  const dir = resolve(process.cwd(), cfg.evidenceDir);
  const file = `${prefix}-${timestamp()}-slot-${slot}-${hash.slice(0, 12)}.json`;
  return { dir, file, path: resolve(dir, file) };
}

export async function writeComputationEvidence({ cfg, request, response, dispatchMode }) {
  if (cfg.evidenceDisabled) return null;
  const hash = requestHash(request);
  const { dir, path } = evidencePath(cfg, 'a-202-computation', request.slot, hash);
  const packet = {
    kind: 'paxiom.sync_committee.computation.v1',
    service: 'A-202',
    generated_at: new Date().toISOString(),
    request_sha256: hash,
    request: {
      slot: request.slot,
      block_root: request.block_root,
      parent_root: request.parent_root,
    },
    response,
    dispatch: {
      mode: dispatchMode,
      mock_device: process.env.MOCK_DEVICE === '1',
      via_subprocess: process.env.BLS_DEVICE_VIA_SUBPROCESS === '1',
      hyperbeam_url: process.env.HYPERBEAM_DISPATCH_URL || null,
    },
    payment: {
      required: cfg.enabled,
      price: cfg.price,
      network: cfg.network,
      facilitator_url: cfg.facilitatorUrl,
      settlement: cfg.enabled ? 'settled-by-x402-middleware-before-response' : 'not-required',
    },
  };
  await mkdir(dir, { recursive: true });
  await writeFile(path, `${JSON.stringify(packet, null, 2)}\n`);
  return path;
}

export async function writeSettlementEvidence({ cfg, context }) {
  if (cfg.evidenceDisabled) return null;
  const slot = context?.transportContext?.request?.adapter?.getBody?.()?.slot || 'unknown';
  const responseBody = context?.transportContext?.responseBody?.toString('utf8') || '';
  const hash = sha256Hex([
    canonicalJson(context.paymentPayload),
    canonicalJson(context.requirements),
    canonicalJson(context.result),
    responseBody,
  ].join('\n'));
  const { dir, path } = evidencePath(cfg, 'a-202-settlement', slot, hash);
  const packet = {
    kind: 'paxiom.sync_committee.settlement.v1',
    service: 'A-202',
    generated_at: new Date().toISOString(),
    payment_requirements: context.requirements,
    payment_result: context.result,
    response_sha256: sha256Hex(responseBody),
  };
  await mkdir(dir, { recursive: true });
  await writeFile(path, `${JSON.stringify(packet, null, 2)}\n`);
  return path;
}
