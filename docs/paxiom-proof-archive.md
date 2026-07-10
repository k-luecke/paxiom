# Paxiom Proof Archive

The proof archive is the next S.03 brick for replacing RPC providers as
authorities. RPC-like systems may still transport bytes, but Paxiom only signs a
customer response after it verifies the witness against Ethereum commitments.
After verification, the service packages the proof material into an encrypted
archive bundle.

## Modes

`PAXIOM_PROOF_ARCHIVE_MODE` controls writes:

- `disabled` — development default. The response envelope emits
  `auditRecord.status:"archive_disabled"` and does not claim durable storage.
- `local` — writes an encrypted bundle to
  `PAXIOM_PROOF_ARCHIVE_DIR` for operator rehearsal.
- `arweave` — signs and posts the encrypted bundle to Arweave.

Strict deployment modes (`PAXIOM_DEPLOYMENT_MODE=testnet|staging|production`)
require `local` or `arweave` for A-201 and A-205.

For a Google Drive-backed cold archive, keep `mode=local` and label the storage
posture explicitly:

```bash
PAXIOM_PROOF_ARCHIVE_WAREHOUSE=google-drive
PAXIOM_PROOF_ARCHIVE_STORAGE_CLASS=cold-warehouse
PAXIOM_PROOF_ARCHIVE_LATENCY_CLASS=async-minutes
```

See `docs/google-drive-proof-warehouse.md` for the slow historical-state
operating model. Drive may hold encrypted proof bundles and manifest indexes
after verification; it should not hold a live Erigon/Reth database.

## Encryption

All non-disabled writes require:

```bash
PAXIOM_PROOF_ARCHIVE_ENCRYPTION_KEY_BASE64=<32-byte-base64-key>
PAXIOM_PROOF_ARCHIVE_KEY_ID=paxiom-proof-archive-key-001
```

The bundle uses `aes-256-gcm`. The public manifest includes only minimal
routing fields and hashes; the full witness/proof payload is encrypted. This is
deliberate: Arweave gives Paxiom permanent storage without turning the storage
layer into a free bypass around Paxiom's paid verifier.

## Arweave and AO

For direct Arweave writes:

```bash
PAXIOM_PROOF_ARCHIVE_MODE=arweave
PAXIOM_ARWEAVE_WALLET_JWK_PATH=/var/lib/paxiom/arweave-wallet.json
```

For AO indexing, set:

```bash
PAXIOM_AO_PROOF_ARCHIVE_PROCESS=<ao-process-id>
```

When configured, Paxiom sends an `IndexProofArchiveBundle` AO message containing
the manifest hash and storage reference. AO is the index/coordination layer; it
is not the trust anchor. The trust anchor remains the Ethereum state root and
the locally verified MPT proof.

## Envelope Fields

A-201 and A-205 now place archive truth in `auditRecord`:

```json
{
  "target": "Paxiom Proof Archive",
  "status": "written_local",
  "aoMessageId": null,
  "arweaveTxId": null,
  "archive": {
    "mode": "local",
    "privacy": "encrypted",
    "manifestHash": "...",
    "bundleSha256": "...",
    "storageRef": "local:..."
  }
}
```

No archive write means `status:"archive_disabled"`, not `pending_write`.

## Integrity Check

After syncing a local archive directory, including a Drive-backed encrypted
bundle directory, run:

```bash
npm run proof-archive:verify -- "$PAXIOM_PROOF_ARCHIVE_DIR"
```

The verifier checks file naming, manifest hashes, encryption metadata, and
guards against accidentally writing plaintext witness fields into the warehouse.
