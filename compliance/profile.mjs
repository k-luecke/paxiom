export const complianceProfile = {
  service: 'COMPLIANCE-001',
  audiences: [
    'CFTC Global Markets Advisory Committee Digital Asset Markets Subcommittee',
    'GDF / ISDA U.S. Tokenized Money Market Fund Working Group',
  ],
  objective:
    'Produce a tamper-evident operational record for tokenized collateral workflows, with explicit evidence for eligibility, finality, custody, valuation, transfer, and risk controls.',
  controlFamilies: [
    {
      id: 'traceability',
      title: 'Event Traceability',
      evidence: ['event_id', 'source_service', 'request_hash', 'chain', 'tx_hash', 'ao_message_id'],
    },
    {
      id: 'finality',
      title: 'Settlement Finality',
      evidence: ['block_number', 'block_hash', 'state_root', 'proof_type', 'verified'],
    },
    {
      id: 'collateral_eligibility',
      title: 'Collateral Eligibility',
      evidence: ['asset_type', 'issuer', 'fund_identifier', 'eligibility_status', 'haircut_bps'],
    },
    {
      id: 'segregation_custody',
      title: 'Segregation and Custody',
      evidence: ['wallet', 'custodian', 'beneficial_owner', 'control_location'],
    },
    {
      id: 'valuation',
      title: 'Valuation and Haircuts',
      evidence: ['price_source', 'valuation_time', 'haircut_bps', 'notional_usd'],
    },
    {
      id: 'operational_risk',
      title: 'Operational Risk',
      evidence: ['mode', 'operator', 'replay_nonce', 'rejection_reason'],
    },
  ],
};

export function classifyEvent(event) {
  const missing = [];
  for (const family of complianceProfile.controlFamilies) {
    const hasAny = family.evidence.some((field) => event[field] !== undefined && event[field] !== '');
    if (!hasAny) missing.push(family.id);
  }
  return {
    complete: missing.length === 0,
    missingControlFamilies: missing,
    audienceReady:
      missing.length === 0
      && event.verified === true
      && Boolean(event.event_type)
      && Boolean(event.source_service),
  };
}

export function summarizeEvents(events) {
  const byType = {};
  const byService = {};
  let audienceReady = 0;
  for (const event of events) {
    byType[event.event_type || 'unknown'] = (byType[event.event_type || 'unknown'] || 0) + 1;
    byService[event.source_service || 'unknown'] = (byService[event.source_service || 'unknown'] || 0) + 1;
    if (classifyEvent(event).audienceReady) audienceReady += 1;
  }
  return {
    service: complianceProfile.service,
    totalEvents: events.length,
    audienceReady,
    byType,
    byService,
    generatedAt: new Date().toISOString(),
  };
}
