import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
  verify,
} from 'node:crypto';

export function canonicalJson(value) {
  if (value === null) return 'null';
  if (value === undefined || typeof value === 'function' || typeof value === 'symbol' || typeof value === 'bigint') {
    throw new Error(`canonicalJson does not support ${typeof value}`);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('canonicalJson does not support non-finite numbers');
    return JSON.stringify(value);
  }
  if (typeof value === 'string') {
    assertValidUnicode(value);
    return JSON.stringify(value);
  }
  if (typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => {
    assertValidUnicode(key);
    return `${JSON.stringify(key)}:${canonicalJson(value[key])}`;
  }).join(',')}}`;
}

function assertValidUnicode(value) {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        throw new Error('canonicalJson does not support lone surrogate code units');
      }
      i += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw new Error('canonicalJson does not support lone surrogate code units');
    }
  }
}

export function sha256Hex(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function requestHash(request) {
  return sha256Hex(canonicalJson(request));
}

export function loadPlatformSigner(env = process.env) {
  const raw = env.PAXIOM_PLATFORM_SIGNING_KEY
    || env.PAXIOM_PLATFORM_PRIVATE_KEY_PEM
    || env.PAXIOM_PLATFORM_PRIVATE_KEY_DER_B64
    || '';

  if (!raw) {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    return signerFromKeyObjects({ privateKey, publicKey, ephemeral: true });
  }

  const privateKey = raw.includes('-----BEGIN')
    ? createPrivateKey(raw.replace(/\\n/g, '\n'))
    : createPrivateKey({
      key: Buffer.from(raw, 'base64'),
      format: 'der',
      type: 'pkcs8',
    });
  return signerFromKeyObjects({
    privateKey,
    publicKey: createPublicKey(privateKey),
    ephemeral: false,
  });
}

function signerFromKeyObjects({ privateKey, publicKey, ephemeral }) {
  const publicKeyDer = publicKey.export({ format: 'der', type: 'spki' });
  const publicKeyBase64 = publicKeyDer.toString('base64');
  const keyId = sha256Hex(publicKeyDer).slice(0, 16);

  return {
    alg: 'ed25519',
    keyId,
    ephemeral,
    publicKey,
    privateKey,
    publicKeyDocument: {
      service: 'A-202',
      alg: 'ed25519',
      public_key: publicKeyBase64,
      key_id: keyId,
      rotated_at: null,
      previous_keys: [],
    },
  };
}

export function buildSignedPayload({ request, response, evidenceId, version, issuedAt = new Date().toISOString() }) {
  return {
    service: 'A-202',
    version,
    request_hash: requestHash(request),
    slot: String(response.slot ?? request.slot),
    block_root: request.block_root,
    signing_root: response.signing_root,
    verified: Boolean(response.verified),
    participating: response.participating,
    committee_size: response.committee_size,
    primitive_return_code: response.primitive_return_code,
    fork_version: response.fork_version,
    domain: response.domain,
    issued_at: issuedAt,
    evidence_id: evidenceId,
  };
}

export function signPayload({ signer, payload }) {
  const canonical = canonicalJson(payload);
  const digest = createHash('sha256').update(canonical).digest();
  const signature = sign(null, digest, signer.privateKey);
  return {
    signedPayload: payload,
    signedPayloadHash: digest.toString('hex'),
    signatureBase64: signature.toString('base64'),
  };
}

export function verifyPayloadSignature({ publicKey, payload, signatureBase64 }) {
  const digest = createHash('sha256').update(canonicalJson(payload)).digest();
  return verify(null, digest, publicKey, Buffer.from(signatureBase64, 'base64'));
}
