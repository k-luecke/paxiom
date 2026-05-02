import { spawn } from 'child_process';
import { readFileSync, writeFileSync, existsSync } from 'fs';

const PAXIOM_PROCESS_ID = 'w_MR7QlkfuRcfd3TQJPD1pzMwU5yEEyLMDjO0Ql8_5I';
const BEACON_URL = 'https://lodestar-mainnet.chainsafe.io';
const VERIFIER_BIN = '/home/mk19/paxiom/rust/bls-verify-cli/target/release/bls-verify-cli';
const PUBKEY_CACHE = '/home/mk19/paxiom/pubkey-cache.json';
const CACHE_TTL = 24 * 60 * 60 * 1000;

async function fetchJSON(url) {
  const res = await fetch(url);
  return res.json();
}

function chunkArray(arr, size) {
  const chunks = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

async function fetchPubkeys(indices) {
  const pubkeys = [];
  for (const chunk of chunkArray(indices, 10)) {
    const query = chunk.map(id => `id=${id}`).join('&');
    const url = `${BEACON_URL}/eth/v1/beacon/states/head/validators?${query}`;
    const json = await fetchJSON(url);
    if (json.data) {
      for (const v of json.data) {
        pubkeys.push(v.validator.pubkey);
      }
    }
  }
  return pubkeys;
}

async function getPubkeys(indices) {
  if (existsSync(PUBKEY_CACHE)) {
    const cache = JSON.parse(readFileSync(PUBKEY_CACHE, 'utf-8'));
    const age = Date.now() - cache.timestamp;
    if (age < CACHE_TTL && cache.pubkeys.length === indices.length) {
      console.log(`Using cached pubkeys (${Math.round(age / 60000)}min old)`);
      return cache.pubkeys;
    }
  }

  console.log('Fetching pubkeys (cache miss)...');
  const pubkeys = await fetchPubkeys(indices);
  writeFileSync(PUBKEY_CACHE, JSON.stringify({ timestamp: Date.now(), pubkeys }));
  console.log(`Fetched and cached ${pubkeys.length} pubkeys`);
  return pubkeys;
}

// FIX: replace execSync shell interpolation with spawn + stdin pipe.
// The verifier JSON is written to stdin — never interpolated into a shell string.
function runVerifier(verifierInput) {
  return new Promise((resolve, reject) => {
    const child = spawn(VERIFIER_BIN, [], {
      stdio: ['pipe', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', d => stdout += d);
    child.stderr.on('data', d => stderr += d);

    child.on('close', code => {
      if (code !== 0) {
        reject(new Error(`Verifier exited ${code}: ${stderr.slice(0, 200)}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch(e) {
        reject(new Error(`Verifier output not valid JSON: ${stdout.slice(0, 200)}`));
      }
    });

    child.on('error', err => {
      reject(new Error(`Failed to spawn verifier: ${err.message}`));
    });

    // Send JSON payload to verifier via stdin
    child.stdin.write(verifierInput);
    child.stdin.end();
  });
}

async function main() {
  console.log('Fetching current Ethereum head...');

  const head = await fetchJSON(`${BEACON_URL}/eth/v1/beacon/headers/head`);
  const slot = head.data.header.message.slot;
  const stateRoot = head.data.header.message.state_root;
  const parentRoot = head.data.header.message.parent_root;
  console.log(`Slot: ${slot}`);

  const block = await fetchJSON(`${BEACON_URL}/eth/v2/beacon/blocks/${slot}`);
  const syncAggregate = block.data.message.body.sync_aggregate;
  console.log('Got sync aggregate');

  const sc = await fetchJSON(`${BEACON_URL}/eth/v1/beacon/states/head/sync_committees`);
  const indices = sc.data.validators;
  console.log(`Got ${indices.length} sync committee indices`);

  const pubkeys = await getPubkeys(indices);

  const verifierInput = JSON.stringify({
    signature: syncAggregate.sync_committee_signature,
    bits: syncAggregate.sync_committee_bits,
    parent_root: parentRoot,
    pubkeys: pubkeys
  });

  console.log('Running BLS verification...');
  let verifyResult;
  try {
    verifyResult = await runVerifier(verifierInput);
  } catch(e) {
    console.log('Verifier error:', e.message);
    return;
  }

  console.log('Verification result:', verifyResult);

  if (verifyResult.verified) {
    console.log(`\nSlot ${slot} VERIFIED - submitting to Paxiom...`);

    // submit-to-ao.sh receives slot and stateRoot as argv — no shell interpolation
    const child = spawn('bash', ['/home/mk19/paxiom/sdk/submit-to-ao.sh', String(slot), stateRoot], {
      detached: true,
      stdio: 'ignore'
    });
    child.unref();

    console.log(`Slot ${slot} submitted to Paxiom (background)`);
    console.log('Signing root:', verifyResult.signing_root);
  } else {
    console.log('Verification failed:', verifyResult.error);
  }
}

main();
