import crypto from 'node:crypto';
if (!globalThis.crypto) {
  globalThis.crypto = crypto.webcrypto;
} else if (!globalThis.crypto.subtle) {
  globalThis.crypto.subtle = crypto.webcrypto.subtle;
}

import { ARIO } from '@ar.io/sdk';
import { createSolanaRpc } from '@solana/rpc';

try {
  console.log('Creating Solana RPC client...');
  const rpc = createSolanaRpc('https://api.mainnet-beta.solana.com');
  const ario = ARIO.init({ rpc });
  console.log('Fetching gateways from Gateway Address Registry on Solana...');
  const res = await ario.getGateways({ limit: 25, sortOrder: 'desc', sortBy: 'operatorStake' });
  const items = res.items || [];
  console.log(`Successfully fetched ${items.length} gateways:`);
  for (const gw of items) {
    const fqdn = gw.settings?.fqdn || gw.fqdn;
    console.log(`- https://${fqdn} | Status: ${gw.status} | Stake: ${gw.operatorStake ? (gw.operatorStake / 1e6).toFixed(0) + ' ARIO' : 'N/A'}`);
  }
} catch (err) {
  console.error('Error:', err);
}
