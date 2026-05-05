import { createHash } from 'node:crypto';

const SUPPORTED_CHAINS = new Set(['ethereum', 'optimism', 'arbitrum', 'base']);

export function verifyMessageEvidence(input) {
  if (!input || typeof input !== 'object') throw new Error('message verification request must be an object');
  const sourceChain = String(input.sourceChain || '').toLowerCase();
  const targetChain = String(input.targetChain || '').toLowerCase();
  if (!SUPPORTED_CHAINS.has(sourceChain)) throw new Error(`unsupported sourceChain: ${sourceChain}`);
  if (!SUPPORTED_CHAINS.has(targetChain)) throw new Error(`unsupported targetChain: ${targetChain}`);
  if (sourceChain === targetChain) throw new Error('sourceChain and targetChain must differ');
  if (!input.messageId && !input.originTxHash) throw new Error('messageId or originTxHash is required');

  const evidence = {
    sourceChain,
    targetChain,
    messageId: input.messageId || null,
    originTxHash: input.originTxHash || null,
    destinationTxHash: input.destinationTxHash || null,
    sourceBlockNumber: input.sourceBlockNumber || null,
    targetBlockNumber: input.targetBlockNumber || null,
    payloadHash: input.payloadHash || null,
  };
  const evidenceHash = createHash('sha256').update(JSON.stringify(evidence, Object.keys(evidence).sort())).digest('hex');
  return {
    service: 'A-203',
    attestation_id: `xmsg-${evidenceHash.slice(0, 16)}`,
    evidence_hash: `0x${evidenceHash}`,
    evidence,
    verified: false,
    status: 'reference_evidence_packet',
    note: 'Evidence shape accepted. Bridge-grade source-chain proof and target-chain verification are the next integration step.',
  };
}
