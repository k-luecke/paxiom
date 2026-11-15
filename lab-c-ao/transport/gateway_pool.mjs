/**
 * AR.IO Decentralized Gateway Pool for Lab C AO Distributed Runner.
 *
 * Discovered from the AR.IO Gateway Address Registry on-chain.
 * Distributes network queries, L1/L2 data access, and worker I/O across
 * physically independent decentralized gateways.
 */

export const ARIO_GATEWAY_POOL = [
  'https://arweave.net',
  'https://vevivo.art',
  'https://ar.mrx.im',
  'https://frostor.xyz',
  'https://turbo-gateway.com',
  'https://gw1.exnihilio.com',
  'https://ario.dogar.dev',
];

/**
 * Assigns an independent gateway to a worker by deterministic index.
 * Ensures worker 1, worker 2, worker p bind to distinct infrastructure providers.
 */
export function getGatewayForWorker(workerIndex, pool = ARIO_GATEWAY_POOL) {
  const idx = typeof workerIndex === 'number' ? workerIndex : parseInt(String(workerIndex).replace(/\D/g, '') || '0', 10);
  return pool[idx % pool.length];
}

/**
 * Probes all gateways in the pool and returns health, block height, and latency.
 */
export async function auditGatewayPool(pool = ARIO_GATEWAY_POOL, timeoutMs = 4000) {
  const results = [];
  for (const gw of pool) {
    const t0 = performance.now();
    try {
      const res = await fetch(`${gw}/info`, { signal: AbortSignal.timeout(timeoutMs) });
      const latencyMs = Number((performance.now() - t0).toFixed(1));
      if (res.ok) {
        const data = await res.json();
        results.push({
          gateway: gw,
          status: 'HEALTHY',
          latency_ms: latencyMs,
          height: data.height,
          peers: data.peers,
          network: data.network,
        });
      } else {
        results.push({
          gateway: gw,
          status: `HTTP_${res.status}`,
          latency_ms: latencyMs,
        });
      }
    } catch (err) {
      results.push({
        gateway: gw,
        status: 'TIMEOUT',
        latency_ms: Number((performance.now() - t0).toFixed(1)),
        error: err.message,
      });
    }
  }
  return results;
}
