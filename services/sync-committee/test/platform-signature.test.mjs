import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPublicKey } from 'node:crypto';
import { Buffer } from 'node:buffer';
import {
  buildSignedPayload,
  canonicalJson,
  loadPlatformSigner,
  signPayload,
  verifyPayloadSignature,
} from '../platform-signature.mjs';

const request = {
  slot: '8421337',
  block_root: '0x' + 'a'.repeat(64),
  parent_root: '0x' + 'b'.repeat(64),
  sync_aggregate: {
    sync_committee_bits: '0x' + 'ff'.repeat(64),
    sync_committee_signature: '0x' + 'c'.repeat(192),
  },
};

const response = {
  verified: true,
  service: 'A-202',
  slot: '8421337',
  fork_version: '0x06000000',
  domain: '0x' + 'd'.repeat(64),
  signing_root: '0x' + 'e'.repeat(64),
  participating: 432,
  committee_size: 512,
  primitive_return_code: 1,
};

function publicKeyFromDocument(keyDoc) {
  return createPublicKey({
    key: Buffer.from(keyDoc.public_key, 'base64'),
    format: 'der',
    type: 'spki',
  });
}

test('canonicalJson is deterministic for signing payloads', () => {
  assert.equal(
    canonicalJson({ b: 2, a: { d: 4, c: 3 } }),
    '{"a":{"c":3,"d":4},"b":2}',
  );
});

test('canonicalJson matches RFC 8785 primitive serialization sample', () => {
  const sample = {
    numbers: [333333333.33333329, 1E30, 4.50, 2e-3, 0.000000000000000000000000001],
    string: "\u20ac$\u000F\u000aA'\u0042\u0022\u005c\\\"/",
    literals: [null, true, false],
  };
  assert.equal(
    canonicalJson(sample),
    '{"literals":[null,true,false],"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27],"string":"€$\\u000f\\nA\'B\\"\\\\\\\\\\"/"}',
  );
});

test('canonicalJson number serialization covers A-202 future-field footguns', () => {
  assert.equal(
    canonicalJson({
      tiny: 1e-27,
      large_exp: 1e30,
      decimal: 0.1,
      negative_zero: -0,
      max_safe_integer: Number.MAX_SAFE_INTEGER,
    }),
    '{"decimal":0.1,"large_exp":1e+30,"max_safe_integer":9007199254740991,"negative_zero":0,"tiny":1e-27}',
  );
});

test('canonicalJson sorts object properties by UTF-16 code units per RFC 8785', () => {
  const sample = {
    '\u20ac': 'Euro Sign',
    '\r': 'Carriage Return',
    '\ufb33': 'Hebrew Letter Dalet With Dagesh',
    1: 'One',
    '\ud83d\ude00': 'Emoji: Grinning Face',
    '\u0080': 'Control',
    '\u00f6': 'Latin Small Letter O With Diaeresis',
  };
  assert.equal(
    canonicalJson(sample),
    '{"\\r":"Carriage Return","1":"One","":"Control","ö":"Latin Small Letter O With Diaeresis","€":"Euro Sign","😀":"Emoji: Grinning Face","דּ":"Hebrew Letter Dalet With Dagesh"}',
  );
});

test('canonicalJson rejects non-I-JSON values that would make signatures ambiguous', () => {
  assert.throws(() => canonicalJson({ bad: undefined }), /does not support undefined/);
  assert.throws(() => canonicalJson({ bad: Number.NaN }), /non-finite numbers/);
  assert.throws(() => canonicalJson({ bad: '\udead' }), /lone surrogate/);
});

test('platform signature round-trips through the published public key document', () => {
  const signer = loadPlatformSigner({});
  const payload = buildSignedPayload({
    request,
    response,
    evidenceId: 'evidence-test',
    version: 'test-sha',
    issuedAt: '2026-05-03T00:00:00.000Z',
  });
  const signature = signPayload({ signer, payload });

  assert.equal(signer.publicKeyDocument.service, 'A-202');
  assert.equal(signer.publicKeyDocument.alg, 'ed25519');
  assert.equal(signature.signedPayloadHash.length, 64);
  assert.equal(verifyPayloadSignature({
    publicKey: publicKeyFromDocument(signer.publicKeyDocument),
    payload: signature.signedPayload,
    signatureBase64: signature.signatureBase64,
  }), true);
});
