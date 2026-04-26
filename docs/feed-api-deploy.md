# Paxiom Feed API Deployment

This is the smallest deployable shape for early subscribers:

- `paxiom-live-prover` continuously writes proof-backed feed records.
- `paxiom-feed-api` serves subscriber-scoped records from the append-only feed file.
- `nginx` or Caddy terminates HTTPS for `api.paxiom.org`.

## 1. Prepare The Host

```bash
sudo useradd --system --create-home --shell /usr/sbin/nologin paxiom
sudo mkdir -p /opt/paxiom /etc/paxiom /var/lib/paxiom
sudo chown -R paxiom:paxiom /opt/paxiom /var/lib/paxiom
```

Clone or rsync the private repo to `/opt/paxiom`, then install dependencies:

```bash
cd /opt/paxiom
npm ci
```

## 2. Configure The Services

```bash
sudo cp deploy/feed-api.env.example /etc/paxiom/feed-api.env
sudo cp deploy/live-prover.env.example /etc/paxiom/live-prover.env
sudo cp deploy/subscribers.example.json /etc/paxiom/subscribers.json
sudo chown root:paxiom /etc/paxiom/*.env /etc/paxiom/subscribers.json
sudo chmod 640 /etc/paxiom/*.env /etc/paxiom/subscribers.json
```

Generate a pilot subscriber token. The command writes only the token hash to the subscriber file
and prints the one-time token to stdout:

```bash
npm run feed:create-subscriber -- \
  --id pilot-uniswap-slot0 \
  --file /etc/paxiom/subscribers.json \
  --scope predicate:uniswap_v3_slot0 \
  --scope subject:ethereum:0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640:slot0
```

Send the printed `token` value to the subscriber once. Do not store the plain token in git.

## 3. Install systemd Units

```bash
sudo cp deploy/paxiom-feed-api.service /etc/systemd/system/
sudo cp deploy/paxiom-live-prover.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now paxiom-live-prover
sudo systemctl enable --now paxiom-feed-api
```

Check logs:

```bash
journalctl -u paxiom-live-prover -f
journalctl -u paxiom-feed-api -f
```

## 4. Put HTTPS In Front

Point DNS for `api.paxiom.org` to the API host. With nginx:

```bash
sudo cp deploy/nginx-api.paxiom.org.conf /etc/nginx/sites-available/api.paxiom.org
sudo ln -s /etc/nginx/sites-available/api.paxiom.org /etc/nginx/sites-enabled/api.paxiom.org
sudo nginx -t
sudo systemctl reload nginx
sudo certbot --nginx -d api.paxiom.org
```

## 5. Smoke Test

```bash
curl https://api.paxiom.org/health

curl "https://api.paxiom.org/v1/predicates?include_planned=false"

curl "https://api.paxiom.org/v1/feed/latest?limit=3" \
  -H "x-paxiom-feed-token: $PAXIOM_FEED_TOKEN"
```

For a local end-to-end auth smoke test, create a local subscriber, write one feed item, then run:

```bash
npm run feed:smoke-auth
```

## Subscriber Scope Format

Scopes can be broad or narrow:

```json
[
  "predicate:uniswap_v3_slot0",
  "feed:ethereum.uniswap_v3_slot0",
  "subject:ethereum:0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640:slot0"
]
```

Use narrow subject scopes for early pilots. Expand only after the subscriber has a clear need.
