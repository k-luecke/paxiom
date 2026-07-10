const STRICT_MODES = new Set(['testnet', 'staging', 'production', 'prod']);

export function deploymentMode() {
  return String(process.env.PAXIOM_DEPLOYMENT_MODE || process.env.PAXIOM_ENV || '').trim().toLowerCase();
}

export function isStrictDeployment() {
  return STRICT_MODES.has(deploymentMode());
}

export function assertNotStrictMode(feature, envVar) {
  if (!isStrictDeployment()) return;
  throw new Error(
    `${feature} is disabled in ${deploymentMode()} mode` +
      (envVar ? ` (unset ${envVar})` : ''),
  );
}

export function assertEnvPair(nameA, nameB) {
  const a = process.env[nameA];
  const b = process.env[nameB];
  if ((a && !b) || (!a && b)) {
    throw new Error(`${nameA} and ${nameB} must be set together`);
  }
}
