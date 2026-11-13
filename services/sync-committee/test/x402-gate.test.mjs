import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyDispatchOutcome } from '../x402-gate.mjs';

const valid = {
  verified: true,
  service: 'A-202',
  slot: '8421337',
  fork_version: '0x06000000',
  domain: '0x' + 'a'.repeat(64),
  signing_root: '0x' + 'b'.repeat(64),
  participating: 432,
  committee_size: 512,
  primitive_return_code: 1,
};

test('verified true is a paid 200 result', () => {
  assert.deepEqual(classifyDispatchOutcome(valid), {
    settle: true,
    httpStatus: 200,
    class: 'verified_true',
  });
});

test('verified false with a computed signing root is a paid 200 result', () => {
  assert.deepEqual(classifyDispatchOutcome({ ...valid, verified: false }), {
    settle: true,
    httpStatus: 200,
    class: 'verified_false',
  });
});

test('structurally invalid verifier output is an unpaid 400', () => {
  const outcome = classifyDispatchOutcome({
    ...valid,
    verified: false,
    error_class: 'structural_invalid',
  });
  assert.equal(outcome.settle, false);
  assert.equal(outcome.httpStatus, 400);
  assert.equal(outcome.class, 'request_error');
});

test('missing signing root is an unpaid request-shape failure', () => {
  const outcome = classifyDispatchOutcome({ ...valid, signing_root: undefined });
  assert.equal(outcome.settle, false);
  assert.equal(outcome.httpStatus, 400);
  assert.equal(outcome.class, 'request_error');
});

test('missing consensus metadata is an unpaid infrastructure failure', () => {
  const outcome = classifyDispatchOutcome({ ...valid, domain: undefined });
  assert.equal(outcome.settle, false);
  assert.equal(outcome.httpStatus, 502);
  assert.equal(outcome.class, 'infrastructure_failure');
});
