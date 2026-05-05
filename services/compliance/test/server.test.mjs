import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server.mjs';

function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      resolve({ server, url: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

const completeEvent = {
  event_type: 'tokenized_collateral_verification',
  source_service: 'R-200',
  request_hash: '0x' + 'a'.repeat(64),
  chain: 'ethereum',
  block_number: 19000000,
  block_hash: '0x' + 'b'.repeat(64),
  state_root: '0x' + 'c'.repeat(64),
  proof_type: 'mpt_storage',
  verified: true,
  asset_type: 'tokenized_money_market_fund',
  issuer: 'example issuer',
  fund_identifier: 'EX-TMMF',
  eligibility_status: 'eligible_for_review',
  haircut_bps: 200,
  wallet: '0x0000000000000000000000000000000000000001',
  custodian: 'qualified custodian',
  beneficial_owner: 'segregated client account',
  control_location: 'onchain',
  price_source: 'independent_nav_oracle',
  valuation_time: '2026-05-05T00:00:00.000Z',
  notional_usd: 1000000,
  mode: 'dry-run',
  operator: 'paxiom-service',
  replay_nonce: 'nonce-1',
};

test('compliance service records events and produces an audience-ready report', async () => {
  const { server, url } = await listen(createApp({ events: [] }));
  try {
    const profile = await fetch(`${url}/v1/compliance/profile`);
    assert.equal(profile.status, 200);
    assert.match((await profile.text()), /Digital Asset Markets Subcommittee/);

    const created = await fetch(`${url}/v1/compliance/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(completeEvent),
    });
    assert.equal(created.status, 201);
    const body = await created.json();
    assert.equal(body.classification.audienceReady, true);

    const report = await fetch(`${url}/v1/compliance/report`);
    const reportBody = await report.json();
    assert.equal(reportBody.summary.totalEvents, 1);
    assert.equal(reportBody.summary.audienceReady, 1);
  } finally {
    server.close();
  }
});
