export const phase1Services = [
  {
    id: 'A-201',
    name: 'Slot Storage Proofs',
    status: 'reference',
    price: { amount: '1.00', unit: 'proof', asset: 'USDC', settlement: 'x402/Base' },
    endpoint: { method: 'POST', path: '/v1/slot-storage-proofs' },
    artifactType: 'slot_storage_proof_packet',
    productUrl: 'https://paxiom.org/services.html',
    blueprintUrl: 'https://paxiom.org/paxiom-phase-1-blueprint.html#a-201',
  },
  {
    id: 'A-202',
    name: 'Sync Committee Verification',
    status: 'reference',
    price: { amount: '0.50', unit: 'verification', asset: 'USDC', settlement: 'x402/Base' },
    endpoint: { method: 'POST', path: '/v1/sync-committee/verify' },
    artifactType: 'sync_committee_verification',
    productUrl: 'https://paxiom.org/services.html',
    blueprintUrl: 'https://paxiom.org/paxiom-phase-1-blueprint.html#a-202',
  },
  {
    id: 'A-203',
    name: 'Cross-Chain Message Verification',
    status: 'reference-evidence-packet',
    price: { amount: '3.00', unit: 'attestation', asset: 'USDC', settlement: 'x402/Base' },
    endpoint: { method: 'POST', path: '/v1/cross-chain-messages/verify' },
    artifactType: 'cross_chain_message_attestation',
    productUrl: 'https://paxiom.org/services.html',
    blueprintUrl: 'https://paxiom.org/paxiom-phase-1-blueprint.html#a-203',
  },
  {
    id: 'A-204',
    name: 'Simulation as a Service',
    status: 'reference-receipt',
    price: { amount: '0.05', unit: 'simulation', asset: 'USDC', settlement: 'x402/Base' },
    endpoint: { method: 'POST', path: '/v1/simulations' },
    artifactType: 'simulation_receipt',
    productUrl: 'https://paxiom.org/services.html',
    blueprintUrl: 'https://paxiom.org/paxiom-phase-1-blueprint.html#a-204',
  },
  {
    id: 'A-205',
    name: 'Verified Historical State',
    status: 'reference',
    price: { amount: '2.00', unit: 'query', asset: 'USDC', settlement: 'x402/Base' },
    endpoint: { method: 'POST', path: '/v1/historical-state/query' },
    artifactType: 'verified_historical_state',
    productUrl: 'https://paxiom.org/services.html',
    blueprintUrl: 'https://paxiom.org/paxiom-phase-1-blueprint.html#a-205',
  },
];

export function phase1Catalog() {
  return {
    project: 'Paxiom',
    catalog: 'Phase 1 Service Schedule',
    source: 'https://paxiom.org/services.html',
    generatedAt: new Date().toISOString(),
    services: phase1Services,
    guarantees: [
      'signed platform response envelope',
      'AO/Arweave audit-record metadata',
      'x402-native payment flow',
      'service-specific verification artifact',
    ],
  };
}
