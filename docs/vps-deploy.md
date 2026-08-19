# VPS Deployment (H2)

The Phase 1 deployment model: **one operator-controlled VPS, services as systemd
units, sharing a filesystem-backed ConfigStore**. This replaces
`docs/google-cloud-vm-deploy.md`, which is removed.

This is an H2 axiom, not an open question. The paths and ownership below are the
contract that #90, #92, #96, #98 and #106 build against. File *names* under these
directories may be refined; the model should not be relocated without reopening
[#118](https://github.com/k-luecke/paxiom/issues/118).

## Why a single host

The five Phase 1 services have **shared mutable operator state**, not per-service
state: the facilitator allowlist (#96), the live-transaction kill switch (#92),
the wallet allowlist (#90), signing/JWKS config (#98), and peer-config drain
(#106). All five are edited by an operator through the UI and read by several
services.

Splitting them across PaaS apps forces one of three things, each worse than a
single host at this scale:

- a sixth "config" service the others poll — a new failure mode, latency on
  every read, a second protocol surface;
- an external store (S3/D1/KV) — a third-party dependency, and a second
  ConfigStore implementation the audit hash chain has to span;
- replicated config sync — eventual consistency in what should be one source of
  truth.

The audit-log hash chain assumes **one writer on one filesystem**. Distributing
the writer means either consensus (overkill here) or accepting a forked chain,
which defeats the point of having one.

A VPS is also less ceremony than GCP — one firewall, one `systemd`, one deploy
script, no IAM/service-account/Cloud-Build surface before it is needed — and
cheaper for a predictable workload. GCP stays available later if a customer
requires it (Phase 2+ B2B, post-SOC 2).

Fly.io and similar remain reasonable for genuinely **stateless** services later
— possibly `bls-device-harness` if it ever needs horizontal scaling. Not for
this shared-state cluster.

## Canonical host layout

| Path | Owner | Mode | Holds |
|---|---|---|---|
| `/opt/paxiom/` | `paxiom:paxiom` | `0755` | Release bundles + `current` symlink |
| `/etc/paxiom/env/` | `root:paxiom` | `0750` | Environment files (secrets) |
| `/var/lib/paxiom/config/` | `paxiom:paxiom` | `0700` | Shared ConfigStore JSON |
| `/var/lib/paxiom/state/` | `paxiom:paxiom` | `0700` | Runtime state (proof archive, wallets) |
| `/var/log/paxiom/` | `paxiom:paxiom` | `0750` | File logs + append-only audit logs |

Service account: `paxiom:paxiom`, system user, no login shell, no home-directory
writes at runtime.

Two rules that the rest of this document depends on:

1. **Only `paxiom` writes to `/var/lib/paxiom` and `/var/log/paxiom`.** The
   systemd template sets `ProtectSystem=strict` with exactly these two
   `ReadWritePaths`, so a compromised service cannot write anywhere else.
2. **`/etc/paxiom/env` is readable by `paxiom` but owned by `root`.** Services
   read their configuration; nothing running as `paxiom` can rewrite it. Raising
   the security floor requires root and a restart — which is what makes it a
   floor.

## Provisioning

Ubuntu 22.04 or 24.04. Any provider; nothing below is provider-specific.

```bash
sudo apt update && sudo apt upgrade -y
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs git logrotate ufw
```

Caddy is in Ubuntu `universe` from 24.04 (`sudo apt install -y caddy`). On
22.04 it is not packaged; add the upstream repository first:

```bash
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
  | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
  | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update && sudo apt install -y caddy
```

Prefer Nginx instead if you would rather not add a third-party repository —
see [Reverse proxy and TLS](#reverse-proxy-and-tls).

Create the service account and the layout:

```bash
# Home is under /var/lib rather than /home on purpose: the systemd template
# sets ProtectHome=true, which makes /home invisible to every unit. Keeping the
# account's home outside /home means a deploy key or npm cache there stays
# readable without weakening that setting.
sudo useradd --system --create-home --home-dir /var/lib/paxiom-home \
  --shell /usr/sbin/nologin paxiom

sudo install -d -o paxiom -g paxiom -m 0755 /opt/paxiom
sudo install -d -o root   -g paxiom -m 0750 /etc/paxiom/env
sudo install -d -o paxiom -g paxiom -m 0700 /var/lib/paxiom/config
sudo install -d -o paxiom -g paxiom -m 0700 /var/lib/paxiom/state
sudo install -d -o paxiom -g paxiom -m 0750 /var/log/paxiom
```

## Releases and code layout

Deploy to a timestamped directory and flip a symlink. The symlink is what makes
rollback a one-second operation instead of a re-clone.

```bash
REL=/opt/paxiom/releases/$(date -u +%Y%m%dT%H%M%SZ)
sudo -u paxiom mkdir -p "$REL"
sudo -u paxiom git clone --depth 1 https://github.com/k-luecke/paxiom.git "$REL"
sudo -u paxiom npm --prefix "$REL" ci --omit=dev
sudo -u paxiom ln -sfn "$REL" /opt/paxiom/current.new
sudo -u paxiom mv -Tf /opt/paxiom/current.new /opt/paxiom/current
```

`mv -T` on a symlink is atomic, so no service ever observes a missing
`current`. Units use `WorkingDirectory=/opt/paxiom/current`.

For a private repo use a read-only deploy key scoped to this repository rather
than a personal access token:

```bash
sudo -u paxiom ssh-keygen -t ed25519 -f /var/lib/paxiom-home/.ssh/id_ed25519 -N ""
sudo cat /var/lib/paxiom-home/.ssh/id_ed25519.pub   # add as a deploy key
```

## Environment files

```bash
sudo cp /opt/paxiom/current/deploy/env/paxiom.env.example /etc/paxiom/env/paxiom.env
sudo chown root:paxiom /etc/paxiom/env/paxiom.env
sudo chmod 0640 /etc/paxiom/env/paxiom.env
sudo nano /etc/paxiom/env/paxiom.env
```

At minimum set `PAXIOM_ALLOWED_WALLETS` — the UI refuses to start without a
wallet matching `/^0x[0-9a-f]{40}$/`.

Per-service secrets go in `/etc/paxiom/env/<service>.env`, loaded after the
shared file and optional:

```bash
sudo install -o root -g paxiom -m 0640 /dev/null /etc/paxiom/env/arb-engine.env
```

Scope secrets this way rather than putting everything in the shared file. The
`sync-committee` service has no reason to be able to read the executor's
`PRIVATE_KEY`, and with one shared file it can.

## ConfigStore contract

`/var/lib/paxiom/config/*.json` is the single source of truth for
operator-mutable configuration. It does not exist in code yet — #96 builds it
and #90, #92, #98, #106 reuse it. The contract:

| File | Issue | Holds |
|---|---|---|
| `wallets.json` | #90 | Admin/member wallet allowlist above the env seed |
| `controls.json` | #92 | `liveTransactionsEnabled` and other kill switches |
| `x402-config.json` | #96 | Facilitator allowlist, per-service price overrides |
| `signing-config.json` | #98 | Active key id, JWKS publication set |
| `peer-migration.json` | #106 | Peer-config drain state |

Rules:

- **Mode `0600`, owner `paxiom`.** The systemd template sets `UMask=0077`, so
  files created by a service get this without the code asking.
- **Atomic writes.** Write `<name>.json.tmp` in the same directory, `fsync`,
  then `rename(2)` over the target. A half-written config must never be
  readable — rename is atomic within a filesystem, `write` is not.
- **Env is the floor, the store may only raise restrictions above it.** Every
  effective value is `env ∧ store` for a boolean gate, or `env ∪ store` for an
  allowlist seed. The store can never enable something the env disables. This
  is what keeps the deploy-time posture auditable: reading
  `/etc/paxiom/env` tells you the maximum privilege the running system can have.
- **Every mutation is audited.** See below.

## Audit log contract

Each ConfigStore file has an adjacent append-only log in `/var/log/paxiom/`,
e.g. `wallets.audit.log`. One record per mutation:

```json
{"ts":"2026-08-19T17:00:00Z","actor":"0xabc...","action":"wallets.add",
 "before":{},"after":{},"prev":"<sha256 of previous record>","self":"<sha256 of this record>"}
```

`prev` chains to the previous record's `self`, so any deletion or edit of
history breaks verification from that point forward. The first record uses
`prev` = 64 zeros.

This is why the deployment model is a single host: the chain has **one writer**.
Two writers produce two chains, and merging them is not possible without
consensus.

Rotation does not break the chain — the links are content hashes, not byte
offsets — but a verifier must read rotated files oldest-first.
`deploy/logrotate/paxiom` handles this; install it as `/etc/logrotate.d/paxiom`.

Service stdout/stderr goes to journald, not here. `/var/log/paxiom` is for the
compliance event log and the audit chains.

## systemd units

```bash
sudo cp /opt/paxiom/current/deploy/systemd/paxiom@.service /etc/systemd/system/
sudo cp /opt/paxiom/current/deploy/logrotate/paxiom /etc/logrotate.d/paxiom
sudo systemctl daemon-reload
```

The five Phase 1 services:

```bash
sudo systemctl enable --now \
  paxiom@slot-storage-proof \
  paxiom@sync-committee \
  paxiom@cross-chain-message \
  paxiom@simulation \
  paxiom@historical-state
```

Supporting units — the service catalog, the compliance relay, and the operator
console:

```bash
sudo systemctl enable --now paxiom@catalog paxiom@compliance paxiom@ui
```

Optional, only if that workload is in use on this host:

```bash
sudo systemctl enable --now paxiom@load-network paxiom@arb-engine
```

The AO poller (`sdk/ao-poller.js`) and the live executor (`sdk/live-executor.js`)
are **not** part of this cluster. They are operator tooling with their own
private-key handling and a shared-secret HMAC link between them
(`PAXIOM_EXEC_SIGNAL_HMAC_KEY`); run them deliberately, not as always-on units,
until that story is settled.

Ports, all bound to `127.0.0.1` — the reverse proxy owns everything public:

| Service | Unit | Port |
|---|---|---|
| A-201 Slot storage proofs | `paxiom@slot-storage-proof` | 8091 |
| A-202 Sync committee | `paxiom@sync-committee` | 8080 |
| A-203 Cross-chain message | `paxiom@cross-chain-message` | 8093 |
| A-204 Simulation | `paxiom@simulation` | 8094 |
| A-205 Historical state | `paxiom@historical-state` | 8095 |
| Service catalog | `paxiom@catalog` | 8090 |
| Compliance | `paxiom@compliance` | 8083 |
| Load network | `paxiom@load-network` | 8081 |
| Arb engine | `paxiom@arb-engine` | 8082 |
| Operator console (UI) | `paxiom@ui` | 3000 |

Health:

```bash
systemctl --no-pager --failed
curl -fsS http://127.0.0.1:3000/healthz
journalctl -u 'paxiom@*' -f
```

The template runs `services/shared/preflight.mjs <service>` before exec'ing the
service, which fails closed on mock flags in `testnet`/`staging`/`production`.
A unit that will not start is often preflight refusing an unsafe config, not a
crash — read the journal before assuming the worse thing.

## Reverse proxy and TLS

Caddy is the default: it obtains and renews certificates with no extra timer,
and it does not rewrite its own config file the way Certbot rewrites Nginx's.

`/etc/caddy/Caddyfile`:

```
console.paxiom.org {
    encode gzip
    reverse_proxy 127.0.0.1:3000
}
```

```bash
sudo systemctl reload caddy
```

Point a DNS `A` record at the host and confirm it resolves before reloading —
certificate issuance fails against a name that does not yet point here:

```bash
dig console.paxiom.org +short
```

Nginx remains supported; `deploy/nginx/paxiom-console.conf` is the plain-HTTP
config, and `certbot --nginx -d console.paxiom.org` will add TLS to it. Use one
or the other, never both — two processes competing for :443 is a confusing
outage.

Only the console is exposed. The A-201..A-205 service ports stay on loopback;
publishing them is a separate decision that needs the x402 gate (#96) settled
first.

## Firewall

```bash
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow 22/tcp
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw enable
```

Nothing else is opened. The service ports are unreachable from outside because
they bind loopback *and* because the firewall drops them — either alone is
enough, and keeping both means a config slip in one does not expose them.

## Backup and restore

Two things must survive host loss: the ConfigStore and the audit logs.
Everything else is redeployable from git.

```bash
sudo -u paxiom tar -czf /var/lib/paxiom/state/backup-$(date -u +%Y%m%dT%H%M%SZ).tar.gz \
  -C / var/lib/paxiom/config var/log/paxiom
```

Copy the archive off the host. Order matters for the audit logs — `tar`
preserves file contents byte for byte, so the hash chain survives; restore the
rotated files under their original names so a verifier can still read them
oldest-first.

Restore:

```bash
sudo systemctl stop 'paxiom@*'
sudo tar -xzf backup-....tar.gz -C /
sudo chown -R paxiom:paxiom /var/lib/paxiom/config /var/log/paxiom
sudo chmod 0700 /var/lib/paxiom/config
sudo systemctl start 'paxiom@*'
```

Stop the services first. Restoring a ConfigStore under a running service means
it may hold a stale in-memory copy and write it back over what you restored.

Verify a restore by checking the audit chain end to end, not by checking that
the services started — a restored-but-truncated log still starts fine.

## Upgrade and rollback

Test then promote:

```bash
# 1. Stage the new release without touching `current`.
REL=/opt/paxiom/releases/$(date -u +%Y%m%dT%H%M%SZ)
sudo -u paxiom git clone --depth 1 https://github.com/k-luecke/paxiom.git "$REL"
sudo -u paxiom npm --prefix "$REL" ci --omit=dev

# 2. Run the gating tests against the staged copy. These are the suites CI
#    enforces, and they pass on a good release.
sudo -u paxiom npm --prefix "$REL" run test:sync-committee
sudo -u paxiom npm --prefix "$REL" run test:load-network
sudo -u paxiom npm --prefix "$REL" run test:sdk

# 3. Back up the ConfigStore before promoting.
sudo -u paxiom tar -czf /var/lib/paxiom/state/pre-upgrade-$(date -u +%Y%m%dT%H%M%SZ).tar.gz \
  -C / var/lib/paxiom/config var/log/paxiom

# 4. Promote atomically and restart.
sudo -u paxiom ln -sfn "$REL" /opt/paxiom/current.new
sudo -u paxiom mv -Tf /opt/paxiom/current.new /opt/paxiom/current
sudo systemctl restart 'paxiom@*'

# 5. Confirm.
systemctl --no-pager --failed
curl -fsS http://127.0.0.1:3000/healthz
```

Do not gate promotion on the full `npm test` yet. `test:services` and
`test:ui` have known failures that predate this runbook and are not in CI, so
the full suite never goes green and would block every upgrade. Use the three
suites above — the ones CI actually enforces — until those are fixed.

Rollback is step 4 pointed at the previous release directory:

```bash
sudo -u paxiom ln -sfn /opt/paxiom/releases/<previous> /opt/paxiom/current.new
sudo -u paxiom mv -Tf /opt/paxiom/current.new /opt/paxiom/current
sudo systemctl restart 'paxiom@*'
```

Keep the last few releases; prune older ones once a new release has run clean
for a while.

**Rollback covers code, not data.** If a release changed a ConfigStore file's
shape, reverting the symlink leaves the new-format file in place for old code
to read. That is what the step-3 backup is for. A ConfigStore schema change
needs a forward migration and a documented down-migration before it ships —
worth stating now, because #96 introduces the first such file.

## What this replaces

`docs/google-cloud-vm-deploy.md` is removed. The GCP-specific parts — project
setup, IAP SSH, IAP-for-browser via an external HTTPS load balancer, and
Google-managed certificates — were provisioning wrappers around the same
systemd + reverse-proxy core kept here.

If browser access needs a second gate beyond the wallet allowlist, Cloudflare
Access in front of the console is the lightest option and does not change the
units, ports, environment files, or allowlist.

## Related

- [#96](https://github.com/k-luecke/paxiom/issues/96) — ConfigStore foundation, the first consumer of the contract above
- [#90](https://github.com/k-luecke/paxiom/issues/90), [#92](https://github.com/k-luecke/paxiom/issues/92), [#98](https://github.com/k-luecke/paxiom/issues/98), [#106](https://github.com/k-luecke/paxiom/issues/106) — the other ConfigStore consumers
- `docs/phase-1-service-catalog.md` — endpoints and pricing for A-201..A-205
- `deploy/systemd/paxiom@.service`, `deploy/env/paxiom.env.example`, `deploy/logrotate/paxiom`
