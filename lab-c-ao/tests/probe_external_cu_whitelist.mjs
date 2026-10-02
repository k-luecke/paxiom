/**
 * Probe External AO Compute Units and HyperBEAM nodes for permissionless execution capability.
 * Tests:
 * 1. cu.ao-testnet.xyz whitelist enforcement and interface.
 * 2. Live AO processes via GraphQL vs custom WASM execution.
 * 3. tee-6.forward.computer and push.forward.computer reachability.
 * 4. Determines whether external compute is open or blocked by whitelist.
 */

import crypto from 'node:crypto';

async function probeUrl(url, timeoutMs = 4000) {
  const t0 = performance.now();
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    const text = await res.text();
    return {
      url,
      ok: res.ok,
      status: res.status,
      latency_ms: Number((performance.now() - t0).toFixed(1)),
      body: text.slice(0, 300),
    };
  } catch (err) {
    return {
      url,
      ok: false,
      status: 'ERROR',
      latency_ms: Number((performance.now() - t0).toFixed(1)),
      error: err.message,
    };
  }
}

async function findLiveAoProcesses() {
  const query = `query {
    transactions(
      tags: [
        { name: "Data-Protocol", values: ["ao"] },
        { name: "Type", values: ["Process"] }
      ],
      first: 5
    ) {
      edges {
        node {
          id
          tags { name value }
        }
      }
    }
  }`;
  try {
    const res = await fetch('https://arweave.net/graphql', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query }),
    });
    const json = await res.json();
    return (json.data?.transactions?.edges || []).map((e) => e.node.id);
  } catch (err) {
    return [];
  }
}

async function testCuDryRun(cuUrl, processId) {
  const payload = {
    Target: processId,
    Owner: '0000000000000000000000000000000000000000000',
    Data: 'test',
    Tags: [
      { name: 'Action', value: 'Eval' },
      { name: 'Data', value: 'return 1 + 1' },
    ],
  };
  try {
    const res = await fetch(`${cuUrl}/dry-run?process-id=${processId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const body = await res.text();
    return {
      status: res.status,
      ok: res.ok,
      body: body.slice(0, 300),
    };
  } catch (err) {
    return { status: 'FETCH_ERROR', error: err.message };
  }
}

async function main() {
  console.log('='.repeat(80));
  console.log('C95-AO-00E: EXTERNAL AO COMPUTE UNIT & HYPERBEAM ACCESS PROBE');
  console.log('='.repeat(80));

  // 1. Probe known CU and HyperBEAM endpoints
  console.log('\n[1/4] Probing Candidate External Compute Endpoints...');
  const endpoints = [
    'https://cu.ao-testnet.xyz',
    'https://cu1006.ao-testnet.xyz',
    'https://cu1007.ao-testnet.xyz',
    'https://tee-6.forward.computer',
    'https://push.forward.computer',
  ];

  const probeResults = [];
  for (const ep of endpoints) {
    probeResults.push(await probeUrl(ep));
  }
  console.table(probeResults);

  // 2. Discover live registered AO processes
  console.log('\n[2/4] Querying Live AO Processes from Arweave GraphQL...');
  const liveProcesses = await findLiveAoProcesses();
  console.log('Discovered live AO processes on Arweave:');
  liveProcesses.forEach((pid, i) => console.log(`  [${i + 1}] ${pid}`));

  // 3. Test dry-run on live processes vs arbitrary ID
  console.log('\n[3/4] Testing CU Execution Interfaces (cu.ao-testnet.xyz)...');
  const arbitraryPid = '0'.repeat(43);
  const testPids = [...liveProcesses.slice(0, 3), arbitraryPid];

  for (const pid of testPids) {
    const isArbitrary = pid === arbitraryPid;
    console.log(`\nTesting DryRun on Process ${pid} (${isArbitrary ? 'Arbitrary Custom Process' : 'Live Network Process'}):`);
    const dryRunResult = await testCuDryRun('https://cu.ao-testnet.xyz', pid);
    console.log(`  Status: ${dryRunResult.status} | Response: ${dryRunResult.body}`);
  }

  // 4. Analysis and certification determination
  console.log(`\n${'='.repeat(80)}`);
  console.log('COMPUTE ACCESSIBILITY VERDICT');
  console.log('='.repeat(80));
}

main().catch((err) => {
  console.error('Fatal probe error:', err);
  process.exit(1);
});
