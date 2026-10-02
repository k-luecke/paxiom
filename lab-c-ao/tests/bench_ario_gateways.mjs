import crypto from 'node:crypto';
if (!globalThis.crypto) globalThis.crypto = crypto.webcrypto;

const arioGateways = [
  'https://ario.dogar.dev',
  'https://ar.mrx.im',
  'https://vevivo.art',
  'https://frostor.xyz',
  'https://gw1.exnihilio.com',
  'https://turbo-gateway.com',
  'https://arweave.net',
];

console.log('='.repeat(80));
console.log('BENCHMARKING AR.IO GATEWAYS (HEALTH, BLOCK HEIGHT, LATENCY)');
console.log('='.repeat(80));

for (const gw of arioGateways) {
  const t0 = performance.now();
  try {
    const res = await fetch(`${gw}/info`, { signal: AbortSignal.timeout(3000) });
    const ms = (performance.now() - t0).toFixed(1);
    if (res.ok) {
      const data = await res.json();
      console.log(`[HEALTHY] ${gw.padEnd(28)} | ${ms.padStart(6)}ms | height: ${data.height} | peers: ${data.peers}`);
    } else {
      console.log(`[STATUS ${res.status}] ${gw.padEnd(28)} | ${ms.padStart(6)}ms`);
    }
  } catch (err) {
    const ms = (performance.now() - t0).toFixed(1);
    console.log(`[TIMEOUT] ${gw.padEnd(28)} | ${ms.padStart(6)}ms | ${err.message}`);
  }
}
