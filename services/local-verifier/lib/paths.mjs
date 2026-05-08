// Default on-disk locations for the local verifier MVP.
// Override the data root with PAXIOM_LOCAL_VERIFIER_DATA_DIR (used by tests).

import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const SERVICE_ROOT = dirname(here);

export function resolveDataDir() {
  if (process.env.PAXIOM_LOCAL_VERIFIER_DATA_DIR) {
    return process.env.PAXIOM_LOCAL_VERIFIER_DATA_DIR;
  }
  return join(SERVICE_ROOT, 'data');
}

export function resolveKeyPaths(dataDir) {
  return {
    privatePath: join(dataDir, 'keys', 'service_key.pem'),
    publicPath: join(dataDir, 'keys', 'service_pub.pem'),
  };
}

export { SERVICE_ROOT };
