// Error taxonomy for the load.network substrate layer.
//
// Four categories matter for downstream handling. Each maps to a distinct
// retry/escalation posture; conflating them is how silent fallbacks and
// repeated retries against permanently-broken state happen.
//
//   NetworkError       — transient HTTP/transport (5xx, 429, timeout, DNS).
//                        Retry with backoff. Same call may succeed later.
//   DataError          — load.network returned a response but its content
//                        is structurally bad (missing fields, wrong types,
//                        empty proof arrays). May be operator error
//                        (wrong block number) or upstream corruption.
//                        Do not retry the same call; surface to caller.
//   VerificationError  — payload received and well-formed, but failed
//                        cryptographic verification (proof did not chain
//                        to the claimed root, value didn't match, key
//                        didn't terminate). Hard fail. NEVER fall back
//                        to a conventional RPC — that would silently
//                        bypass the no-RPC architectural moat.
//   ProtocolError      — load.network responded in a shape we do not
//                        recognise (e.g. unexpected field, schema drift).
//                        Investigate; do not retry.
//
// The base class preserves rich context (status, body, attempt count,
// stage of pipeline, request id) for log correlation and incident review.

export class LoadNetworkError extends Error {
  constructor(message, ctx = {}) {
    super(message);
    this.name = 'LoadNetworkError';
    this.category = ctx.category;
    this.status = ctx.status;
    this.body = ctx.body;
    this.attempt = ctx.attempt;
    this.stage = ctx.stage;
    this.requestId = ctx.requestId;
    this.cause = ctx.cause;
  }
}

export class LoadNetworkNetworkError extends LoadNetworkError {
  constructor(message, ctx = {}) {
    super(message, { ...ctx, category: 'NETWORK' });
    this.name = 'LoadNetworkNetworkError';
    this.retryable = true;
  }
}

export class LoadNetworkDataError extends LoadNetworkError {
  constructor(message, ctx = {}) {
    super(message, { ...ctx, category: 'DATA' });
    this.name = 'LoadNetworkDataError';
    this.retryable = false;
  }
}

export class LoadNetworkVerificationError extends LoadNetworkError {
  constructor(message, ctx = {}) {
    super(message, { ...ctx, category: 'VERIFICATION' });
    this.name = 'LoadNetworkVerificationError';
    this.retryable = false;
    this.reason = ctx.reason;
    this.expectedRoot = ctx.expectedRoot;
    this.observedValue = ctx.observedValue;
    this.expectedValue = ctx.expectedValue;
    this.key = ctx.key;
  }
}

export class LoadNetworkProtocolError extends LoadNetworkError {
  constructor(message, ctx = {}) {
    super(message, { ...ctx, category: 'PROTOCOL' });
    this.name = 'LoadNetworkProtocolError';
    this.retryable = false;
    this.field = ctx.field;
  }
}

// Reasons used by VerificationError. Stable strings so logs and metrics
// can group on them without sniffing message text.
export const VerificationReasons = Object.freeze({
  PROOF_ROOT_MISMATCH:    'PROOF_ROOT_MISMATCH',
  PROOF_INVALID:          'PROOF_INVALID',
  ACCOUNT_VALUE_MISMATCH: 'ACCOUNT_VALUE_MISMATCH',
  STORAGE_VALUE_MISMATCH: 'STORAGE_VALUE_MISMATCH',
  ACCOUNT_KEY_MISSING:    'ACCOUNT_KEY_MISSING',
  EMPTY_PROOF:            'EMPTY_PROOF',
});
