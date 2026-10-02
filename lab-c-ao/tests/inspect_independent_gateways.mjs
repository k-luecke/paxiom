const PROCESS_ID = 'w_MR7QlkfuRcfd3TQJPD1pzMwU5yEEyLMDjO0Ql8_5I';

const targetGateways = [
  'https://frostor.xyz',
  'https://turbo-gateway.com',
  'https://ario.dogar.dev',
];

console.log('='.repeat(80));
console.log('INSPECTING LIVE INDEPENDENT HYPERBEAM / CU GATEWAYS');
console.log('='.repeat(80));

for (const gw of targetGateways) {
  console.log(`\n>>> GATEWAY: ${gw}`);

  // 1. Inspect ~meta@1.0/info
  try {
    const metaRes = await fetch(`${gw}/~meta@1.0/info`);
    console.log(`  /~meta@1.0/info status: ${metaRes.status}`);
    const metaHeaders = {};
    for (const [k, v] of metaRes.headers.entries()) {
      if (k.includes('signature') || k.includes('ao') || k.includes('server')) {
        metaHeaders[k] = v;
      }
    }
    console.log('  Meta Headers:', metaHeaders);
    const metaTxt = await metaRes.text();
    console.log('  Meta Body snippet:', metaTxt.slice(0, 200));
  } catch (err) {
    console.log('  Meta error:', err.message);
  }

  // 2. Inspect /cu/dry-run
  try {
    const cuRes = await fetch(`${gw}/cu/dry-run?process-id=${PROCESS_ID}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        Id: '0000000000000000000000000000000000000000001',
        Target: PROCESS_ID,
        Owner: '1111111111111111111111111111111111111111111',
        Data: 'ping',
        Tags: [{ name: 'Action', value: 'Info' }],
      }),
    });
    console.log(`  /cu/dry-run status: ${cuRes.status}`);
    const cuHeaders = {};
    for (const [k, v] of cuRes.headers.entries()) {
      if (k.includes('signature') || k.includes('ao') || k.includes('server') || k.includes('cu')) {
        cuHeaders[k] = v;
      }
    }
    console.log('  CU Headers:', cuHeaders);
    const cuTxt = await cuRes.text();
    console.log('  CU Body snippet:', cuTxt.slice(0, 300));
  } catch (err) {
    console.log('  CU error:', err.message);
  }
}
