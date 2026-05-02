// Thin wrapper around the call into the BLS device.
//
// Two modes:
//   - HYPERBEAM dispatch: POST to a running HyperBEAM node's hb_ao endpoint.
//     Requires hyperbeam/bringup to have produced a live node and the
//     device to have been registered via register.sh.
//   - MOCK_DEVICE=1:    spawn the local bls-device-harness binary (or, if
//     it isn't built yet, return a synthesised response so the service
//     and its tests are exercisable without HyperBEAM. Useful for CI and
//     for fixture-driven integration tests.

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';

// Read env on every call so tests can flip MOCK_DEVICE after import.
function config() {
  return {
    hyperbeamDispatchUrl:
      process.env.HYPERBEAM_DISPATCH_URL
      || 'http://localhost:8080/hb_ao/~bls-sync-committee@1.0/verify',
    harnessBin: process.env.BLS_DEVICE_HARNESS || '/usr/local/bin/bls-device-harness',
    mock: process.env.MOCK_DEVICE === '1',
    viaSubprocess: process.env.BLS_DEVICE_VIA_SUBPROCESS === '1',
  };
}

export async function dispatch(req) {
  const cfg = config();
  if (cfg.mock) return mockDispatch(req);
  if (cfg.viaSubprocess) return harnessDispatch(req, cfg.harnessBin);
  return hyperbeamDispatch(req, cfg.hyperbeamDispatchUrl);
}

async function hyperbeamDispatch(req, url) {
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(req),
  });
  if (!resp.ok) {
    throw new Error(`hyperbeam dispatch returned ${resp.status}: ${await resp.text()}`);
  }
  return await resp.json();
}

function harnessDispatch(req, harnessBin) {
  return new Promise((resolve, reject) => {
    const child = spawn(harnessBin, ['--json'], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`harness exited ${code}: ${stderr.slice(0, 200)}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch (e) {
        reject(new Error(`harness stdout not JSON: ${stdout.slice(0, 200)}`));
      }
    });
    child.stdin.write(JSON.stringify(req));
    child.stdin.end();
  });
}

// Synthesises a VerifyResponse without hitting any beacon or running blst.
// Verification status is keyed off the request hash; tests can assert shape
// and round-trip without standing up the full Rust harness.
function mockDispatch(req) {
  const hash = createHash('sha256');
  hash.update(JSON.stringify({
    s: req.slot, b: req.block_root, p: req.parent_root,
    bi: req.sync_aggregate.sync_committee_bits,
    si: req.sync_aggregate.sync_committee_signature,
  }));
  const digest = hash.digest('hex');

  return Promise.resolve({
    verified: true,
    service: 'A-202',
    slot: req.slot,
    fork_version: '0x06000000',
    domain: '0x' + 'a'.repeat(64),
    signing_root: '0x' + digest,
    participating: 432,
    committee_size: 512,
    primitive_return_code: 1,
    platform_signature: '0x' + digest,
    ao_message_id: `mock-ao-${req.slot}-${digest.slice(0, 12)}`,
  });
}
