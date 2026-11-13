import { readFile } from 'node:fs/promises';
import { x402Client, x402HTTPClient } from '@x402/core/client';
import { ExactEvmScheme, toClientEvmSigner } from '@x402/evm';
import {
  createPublicClient,
  formatEther,
  formatUnits,
  http,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { baseSepolia } from 'viem/chains';

const ERC20_BALANCE_ABI = [
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
];

const ENDPOINT = process.env.A202_URL || 'http://127.0.0.1:8096/v1/sync-committee/verify';
const BEACON = (process.env.A202_BEACON_URL || 'https://ethereum-beacon-api.publicnode.com').replace(/\/+$/, '');
const RPC_URL = process.env.BASE_SEPOLIA_RPC_URL || 'https://sepolia.base.org';
const BUYER_KEY =
  process.env.PAXIOM_TESTNET_BUYER_PRIVATE_KEY
  || process.env.X402_BUYER_PRIVATE_KEY
  || process.env.BASE_SEPOLIA_PRIVATE_KEY
  || '';

function assertBuyerKey(raw) {
  if (!/^0x[0-9a-fA-F]{64}$/.test(raw)) {
    throw new Error(
      'Set PAXIOM_TESTNET_BUYER_PRIVATE_KEY to a 0x-prefixed Base Sepolia buyer private key.',
    );
  }
}

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} returned ${res.status}: ${await res.text()}`);
  return res.json();
}

async function buildBeaconRequest() {
  if (process.env.A202_REQUEST_JSON) {
    return JSON.parse(await readFile(process.env.A202_REQUEST_JSON, 'utf8'));
  }

  const slot = process.env.A202_SLOT
    || (await fetchJson(`${BEACON}/eth/v1/beacon/headers/finalized`)).data.header.message.slot;
  const [header, block] = await Promise.all([
    fetchJson(`${BEACON}/eth/v1/beacon/headers/${slot}`),
    fetchJson(`${BEACON}/eth/v2/beacon/blocks/${slot}`),
  ]);

  return {
    slot: String(slot),
    block_root: header.data.root,
    parent_root: block.data.message.parent_root,
    sync_aggregate: block.data.message.body.sync_aggregate,
  };
}

async function main() {
  assertBuyerKey(BUYER_KEY);

  const account = privateKeyToAccount(BUYER_KEY);
  const publicClient = createPublicClient({ chain: baseSepolia, transport: http(RPC_URL) });
  const signer = toClientEvmSigner(account, publicClient);
  const coreClient = new x402Client().register('eip155:84532', new ExactEvmScheme(signer));
  const httpClient = new x402HTTPClient(coreClient);
  const request = await buildBeaconRequest();

  const first = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(request),
  });

  if (first.status !== 402) {
    throw new Error(`Expected unpaid request to return 402, got ${first.status}: ${await first.text()}`);
  }

  const paymentRequired = httpClient.getPaymentRequiredResponse((name) => first.headers.get(name));
  const selected = paymentRequired.accepts.find((a) => a.scheme === 'exact' && a.network === 'eip155:84532');
  if (!selected) {
    throw new Error(`No exact/eip155:84532 payment requirement: ${JSON.stringify(paymentRequired.accepts)}`);
  }

  const [ethBalance, tokenBalance] = await Promise.all([
    publicClient.getBalance({ address: account.address }),
    publicClient.readContract({
      address: selected.asset,
      abi: ERC20_BALANCE_ABI,
      functionName: 'balanceOf',
      args: [account.address],
    }),
  ]);

  console.log(JSON.stringify({
    buyer: account.address,
    endpoint: ENDPOINT,
    slot: request.slot,
    payment: {
      scheme: selected.scheme,
      network: selected.network,
      amount: selected.amount,
      asset: selected.asset,
      payTo: selected.payTo,
    },
    balances: {
      base_sepolia_eth: formatEther(ethBalance),
      token_units: tokenBalance.toString(),
      token_display_6_decimals: formatUnits(tokenBalance, 6),
    },
  }, null, 2));

  if (tokenBalance < BigInt(selected.amount)) {
    throw new Error(
      `Insufficient testnet USDC: need ${selected.amount} base units, have ${tokenBalance.toString()}.`,
    );
  }

  const paymentPayload = await httpClient.createPaymentPayload(paymentRequired);
  const paymentHeaders = httpClient.encodePaymentSignatureHeader(paymentPayload);
  const second = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...paymentHeaders },
    body: JSON.stringify(request),
  });

  const text = await second.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch (_e) {
    body = { raw: text.slice(0, 500) };
  }

  console.log(JSON.stringify({
    result: {
      http_status: second.status,
      payment_response_present: Boolean(second.headers.get('payment-response')),
      paxiom_signature_present: Boolean(second.headers.get('x-paxiom-signature')),
      paxiom_evidence_packet: second.headers.get('x-paxiom-evidence-packet'),
      verified: body?.verified,
      participating: body?.participating,
      committee_size: body?.committee_size,
      platform_key_id: body?.platform_key_id,
      body_preview: second.status === 200 ? undefined : body,
    },
  }, null, 2));

  if (second.status !== 200) {
    throw new Error(`Paid retry did not return 200; got ${second.status}.`);
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.stack : e);
  process.exit(1);
});
