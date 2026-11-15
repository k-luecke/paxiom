import crypto from 'node:crypto';
if (!globalThis.crypto) {
  globalThis.crypto = crypto.webcrypto;
}

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const aoconnectPkgPath = path.resolve(__dirname, '../../node_modules/@permaweb/aoconnect/dist/index.js');
const { connect, createDataItemSigner } = await import(`file://${aoconnectPkgPath}`);

const walletPath = path.join(process.env.HOME, '.aos.json');
const wallet = JSON.parse(fs.readFileSync(walletPath, 'utf8'));
const signer = createDataItemSigner(wallet);

console.log('='.repeat(80));
console.log('TESTING SIGNED MESSAGE DISPATCH VIA MULTIPLE AR.IO GATEWAYS');
console.log('='.repeat(80));

const gateways = [
  'https://arweave.net',
  'https://turbo-gateway.com',
  'https://frostor.xyz',
];

const TARGET_PROCESS = 'w_MR7QlkfuRcfd3TQJPD1pzMwU5yEEyLMDjO0Ql8_5I';

for (const gw of gateways) {
  console.log(`\nTesting gateway: ${gw}`);
  const ao = connect({
    GATEWAY_URL: gw,
    MU_URL: 'https://mu.ao-testnet.xyz',
    CU_URL: 'https://cu.ao-testnet.xyz',
  });

  const t0 = performance.now();
  try {
    const msgId = await ao.message({
      process: TARGET_PROCESS,
      signer,
      tags: [
        { name: 'Action', value: 'Probe' },
        { name: 'Timestamp', value: String(Date.now()) },
      ],
      data: JSON.stringify({ probe: '00d0', gateway: gw }),
    });
    const ms = (performance.now() - t0).toFixed(1);
    console.log(`  [SUCCESS] Message dispatched via ${gw} in ${ms}ms! Message ID: ${msgId}`);
  } catch (err) {
    const ms = (performance.now() - t0).toFixed(1);
    console.log(`  [FAIL] Dispatch via ${gw} failed in ${ms}ms: ${err.message}`);
  }
}
