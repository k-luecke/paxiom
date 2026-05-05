import { createHash, sign } from 'node:crypto';

export function createServiceEnvelope({
  service,
  serviceName,
  artifactType,
  payload,
  audit = {},
  payment,
}) {
  const generatedAt = new Date().toISOString();
  const response = {
    service,
    serviceName,
    generatedAt,
    artifact: {
      type: artifactType,
      payload,
    },
    auditRecord: {
      target: 'AO/Arweave',
      status: audit.status || 'pending_write',
      aoMessageId: audit.aoMessageId || null,
      arweaveTxId: audit.arweaveTxId || null,
      evidenceTags: audit.evidenceTags || [],
    },
    payment: payment ? {
      mode: payment.mode,
      verified: payment.verified,
      receiptId: payment.receiptId || null,
    } : null,
  };
  const responseHash = sha256Json(response);
  return {
    ...response,
    platformSignature: signResponse(responseHash),
  };
}

function signResponse(responseHash) {
  const privateKey = process.env.PAXIOM_RESPONSE_SIGNING_PRIVATE_KEY_PEM;
  if (!privateKey) {
    throw new Error(
      'PAXIOM_RESPONSE_SIGNING_PRIVATE_KEY_PEM is required to sign service envelopes. ' +
      'Refusing to emit forgeable dev signatures (audit H-01, issue #12). ' +
      'Provide an ed25519 PKCS8 PEM key.',
    );
  }
  const sig = sign(null, Buffer.from(responseHash, 'hex'), privateKey).toString('base64');
  return {
    algorithm: 'ed25519',
    keyId: process.env.PAXIOM_RESPONSE_SIGNING_KEY_ID || 'paxiom-hot-response-key',
    responseHash: `0x${responseHash}`,
    signature: sig,
  };
}

function sha256Json(value) {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
}
