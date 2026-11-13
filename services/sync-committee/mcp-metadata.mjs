const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

export function mcpMetadata(cfg) {
  return {
    name: 'paxiom.sync_committee.verify',
    title: 'Paxiom A-202 Sync Committee Verification',
    description: 'x402-payable verification of an Ethereum beacon-chain sync committee aggregate.',
    endpoint: '/v1/sync-committee/verify',
    method: 'POST',
    service: 'A-202',
    payment: {
      protocol: 'x402',
      enabled: cfg.enabled,
      mode: cfg.mode,
      network: cfg.network,
      price: cfg.price,
      facilitator_url: cfg.facilitatorUrl,
      pay_to_configured: ADDRESS_RE.test(cfg.payTo),
    },
    attestation: {
      signature_alg: 'ed25519',
      public_key_url: `${cfg.publicBaseUrl}/.well-known/paxiom-platform-pubkey.json`,
      canonicalization: 'deterministic recursive key sort, equivalent to the JSON subset used by JCS/RFC 8785',
    },
    run_modes: {
      mock_device_billable: false,
      first_paid_runtime: 'BLS_DEVICE_VIA_SUBPROCESS=1',
      later_runtime: 'HyperBEAM-hosted ~bls-sync-committee@1.0 after registration is proven',
    },
  };
}
