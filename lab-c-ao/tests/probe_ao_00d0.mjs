import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const aoconnectPkgPath = path.resolve(__dirname, '../../node_modules/@permaweb/aoconnect/dist/index.js');
const { connect } = await import(`file://${aoconnectPkgPath}`);

const arioGateways = [
  'https://ario.dogar.dev',
  'https://frostor.xyz',
  'https://turbo-gateway.com',
  'https://vevivo.art',
  'https://arweave.net',
];

console.log('='.repeat(80));
console.log('TESTING MULTIPLE AR.IO GATEWAYS WITH @permaweb/aoconnect');
console.log('='.repeat(80));

for (const gw of arioGateways) {
  console.log(`\nConnecting via Gateway: ${gw}`);
  const ao = connect({
    GATEWAY_URL: gw,
    MU_URL: 'https://mu.ao-testnet.xyz',
    CU_URL: 'https://cu.ao-testnet.xyz',
  });

  const t0 = performance.now();
  try {
    // Read transaction info or message via gateway
    const res = await fetch(`${gw}/tx/0syT13r0s0tgPfgM1T0YcwM2JD4Jyokydzs9-a8FQ4`, { signal: AbortSignal.timeout(3000) });
    const duration = (performance.now() - t0).toFixed(1);
    console.log(`  [OK] Gateway ${gw} responded in ${duration}ms (status ${res.status})`);
  } catch (err) {
    console.log(`  [FAIL] Gateway ${gw}: ${err.message}`);
  }
}
