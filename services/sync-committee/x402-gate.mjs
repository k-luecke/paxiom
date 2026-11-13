const HEX_32_RE = /^0x[0-9a-fA-F]{64}$/;
const HEX_4_RE = /^0x[0-9a-fA-F]{8}$/;

function hasValidSigningRoot(result) {
  return HEX_32_RE.test(result?.signing_root ?? '');
}

function hasValidDomain(result) {
  return HEX_32_RE.test(result?.domain ?? '');
}

function hasValidForkVersion(result) {
  return HEX_4_RE.test(result?.fork_version ?? '');
}

function hasInteger(value) {
  return Number.isInteger(value);
}

export function classifyDispatchOutcome(result) {
  if (!result || typeof result !== 'object') {
    return {
      settle: false,
      httpStatus: 502,
      error: 'dispatch returned no structured result',
      class: 'infrastructure_failure',
    };
  }

  if (result.error_class === 'structural_invalid') {
    return {
      settle: false,
      httpStatus: 400,
      error: result.error || 'structurally invalid verifier input',
      class: 'request_error',
    };
  }

  if (typeof result.verified !== 'boolean') {
    return {
      settle: false,
      httpStatus: 502,
      error: 'verifier result missing boolean verified field',
      class: 'infrastructure_failure',
    };
  }

  if (!hasValidSigningRoot(result)) {
    return {
      settle: false,
      httpStatus: 400,
      error: 'verifier did not return a valid signing_root',
      class: 'request_error',
    };
  }

  if (!hasValidForkVersion(result) || !hasValidDomain(result)) {
    return {
      settle: false,
      httpStatus: 502,
      error: 'verifier result missing required consensus metadata',
      class: 'infrastructure_failure',
    };
  }

  if (!hasInteger(result.participating) || !hasInteger(result.committee_size) || !hasInteger(result.primitive_return_code)) {
    return {
      settle: false,
      httpStatus: 502,
      error: 'verifier result missing required numeric metadata',
      class: 'infrastructure_failure',
    };
  }

  return {
    settle: true,
    httpStatus: 200,
    class: result.verified ? 'verified_true' : 'verified_false',
  };
}
