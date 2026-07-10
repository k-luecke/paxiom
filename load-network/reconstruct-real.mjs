// Prove the verifiable-state foundation end-to-end against REAL Ethereum
// mainnet data: fetch an EIP-1186 proof for WETH @ block 19,000,000, walk the
// MPT locally, and only accept the value because the proof verifies. The RPC
// is transport, not authority — swap it for Ultraviolet/Erigon later without
// touching the trust model.
import { ErigonProofClient } from './erigon-client.mjs';
import { reconstructStorageSlot } from './reconstruct.mjs';

const WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';
const BLOCK = 19_000_000;
const SLOT = '0x0';

// Public archive RPCs that serve eth_getProof at historical blocks. First that
// works wins. (Source-agnostic: the verifier is the trust anchor.)
const RPCS = [
  'https://eth.llamarpc.com',
  'https://ethereum-rpc.publicnode.com',
  'https://eth.drpc.org',
  'https://1rpc.io/eth',
];

for (const rpcUrl of RPCS) {
  process.stdout.write(`\n=== source: ${rpcUrl} ===\n`);
  const client = new ErigonProofClient({ rpcUrl });
  try {
    const r = await reconstructStorageSlot({ blockNumber: BLOCK, address: WETH, slot: SLOT, client });
    console.log('VERIFIED ✓ (MPT proof walked locally)');
    console.log('  block       :', r.block_number);
    console.log('  state_root  :', r.state_root);
    console.log('  address     :', r.address);
    console.log('  storage_root:', r.storage_root);
    console.log(`  slot ${SLOT}     : ${r.value}`);
    console.log('  witness     : account_proof[%d] + storage_proof[%d] nodes',
      r.witness.account_proof.length, r.witness.storage_proof.length);
    console.log('\nFOUNDATION PROVEN: real mainnet state accepted because the proof verified.');
    process.exit(0);
  } catch (e) {
    console.log('  failed:', e.constructor.name, '-', String(e.message).slice(0, 120));
  }
}
console.log('\nNo public archive RPC served a verifiable eth_getProof at block', BLOCK);
process.exit(1);
