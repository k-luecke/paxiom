import crypto from 'node:crypto';
if (!globalThis.crypto) {
  globalThis.crypto = crypto.webcrypto;
} else if (!globalThis.crypto.subtle) {
  globalThis.crypto.subtle = crypto.webcrypto.subtle;
}

const PROCESS_ID = 'w_MR7QlkfuRcfd3TQJPD1pzMwU5yEEyLMDjO0Ql8_5I';

const sampleGateways = [
  'https://ario.dogar.dev',
  'https://ar.mrx.im',
  'https://vevivo.art',
  'https://frostor.xyz',
  'https://gw1.exnihilio.com',
  'https://permagate.io',
  'https://arweave.tokyo',
  'https://aoweave.tech',
  'https://turbo-gateway.com',
  'https://arweave.net',
];

console.log('='.repeat(80));
console.log('PROBING AR.IO INDEPENDENT GATEWAYS FOR AO ENDPOINTS & ROUTING');
console.log('='.repeat(80));

for (const gw of sampleGateways) {
  console.log(`\nTesting Gateway: ${gw}`);
  
  // 1. Arweave info endpoint
  try {
    const t0 = performance.now();
    const res = await fetch(`${gw}/info`, { signal: AbortSignal.timeout(3000) });
    const ms = (performance.now() - t0).toFixed(1);
    if (res.ok) {
      const data = await res.json();
      console.log(`  [OK] /info (${ms}ms) -> network: ${data.network}, height: ${data.height}, peers: ${data.peers}`);
    } else {
      console.log(`  [STATUS ${res.status}] /info (${ms}ms)`);
    }
  } catch (err) {
    console.log(`  [FAIL] /info -> ${err.message}`);
  }

  // 2. AR.IO gateway info endpoint
  try {
    const res = await fetch(`${gw}/ar-io/info`, { signal: AbortSignal.timeout(3000) });
    if (res.ok) {
      const data = await res.json();
      console.log(`  [OK] /ar-io/info -> wallet: ${data.wallet || data.observerWallet || 'N/A'}, version: ${data.version || 'N/A'}`);
    }
  } catch (err) {
    // optional
  }

  // 3. HyperBEAM ~meta@1.0 / HyperPATH check
  try {
    const res = await fetch(`${gw}/~meta@1.0/info`, { signal: AbortSignal.timeout(2000) });
    if (res.status !== 404 && res.status !== 502) {
      console.log(`  [HYPERBEAM?] /~meta@1.0/info -> status ${res.status}`);
    }
  } catch (err) {}

  // 4. AO CU / dryrun endpoint check
  try {
    const res = await fetch(`${gw}/cu/dry-run?process-id=${PROCESS_ID}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        Id: '0000000000000000000000000000000000000000001',
        Target: PROCESS_ID,
        Owner: '1111111111111111111111111111111111111111111',
        Data: 'ping',
        Tags: [{ name: 'Action', value: 'Info' }],
      }),
      signal: AbortSignal.timeout(3000),
    });
    console.log(`  [CU ROUTE?] /cu/dry-run -> status ${res.status}`);
  } catch (err) {}
}
