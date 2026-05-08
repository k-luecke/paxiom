// Local audit store.
//
// - One JSON file per receipt under <dataDir>/receipts/<receipt_id>.json
// - Append-only JSONL audit log at <dataDir>/audit.log.jsonl
// - Tracks the prior receipt_hash so the chain is linkable on replay.

import { mkdirSync, writeFileSync, readFileSync, existsSync, appendFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export function createStore(dataDir) {
  const receiptsDir = join(dataDir, 'receipts');
  const auditLogPath = join(dataDir, 'audit.log.jsonl');
  mkdirSync(receiptsDir, { recursive: true });

  function persist(receipt) {
    const path = join(receiptsDir, `${receipt.receipt_id}.json`);
    writeFileSync(path, JSON.stringify(receipt, null, 2));
    appendFileSync(auditLogPath, JSON.stringify(receipt) + '\n');
    return path;
  }

  function load(receiptId) {
    const path = join(receiptsDir, `${receiptId}.json`);
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, 'utf8'));
  }

  function lastReceiptHash() {
    if (!existsSync(auditLogPath)) return null;
    const text = readFileSync(auditLogPath, 'utf8');
    const lines = text.split('\n').filter((l) => l.length > 0);
    if (lines.length === 0) return null;
    try {
      const last = JSON.parse(lines[lines.length - 1]);
      return last.receipt_hash || null;
    } catch {
      return null;
    }
  }

  function listReceiptIds() {
    if (!existsSync(receiptsDir)) return [];
    return readdirSync(receiptsDir)
      .filter((n) => n.endsWith('.json'))
      .map((n) => n.replace(/\.json$/, ''));
  }

  return { persist, load, lastReceiptHash, listReceiptIds, receiptsDir, auditLogPath };
}
