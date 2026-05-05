# Google Cloud VM Deployment

This is the first private operator-console deployment path. It is intentionally
plain Compute Engine plus systemd plus Nginx. Do not expose the service ports
directly; only Nginx should receive public web traffic.

## Google Cloud setup

Use `e2-standard-4` for the first real private deployment unless cost is a hard
constraint. `e2-standard-2` works for a light operator test, but the full stack
runs ten Node services and benefits from the extra headroom.

```bash
gcloud services enable compute.googleapis.com iap.googleapis.com

gcloud compute addresses create paxiom-static-ip --region=us-central1

gcloud compute instances create paxiom-console \
  --zone=us-central1-a \
  --machine-type=e2-standard-4 \
  --boot-disk-size=50GB \
  --boot-disk-type=pd-balanced \
  --address=paxiom-static-ip \
  --tags=paxiom-console \
  --image-family=ubuntu-2204-lts \
  --image-project=ubuntu-os-cloud

gcloud compute firewall-rules create allow-paxiom-http-https \
  --action=ALLOW \
  --direction=INGRESS \
  --rules=tcp:80,tcp:443 \
  --source-ranges=0.0.0.0/0 \
  --target-tags=paxiom-console

gcloud compute firewall-rules create allow-paxiom-iap-ssh \
  --action=ALLOW \
  --direction=INGRESS \
  --rules=tcp:22 \
  --source-ranges=35.235.240.0/20 \
  --target-tags=paxiom-console
```

For IAP SSH, your Google account needs the IAP tunnel role plus Compute
permissions on the project or instance. Grant narrowly if you already have an
IAM pattern; the broad project-level shape is:

```bash
gcloud projects add-iam-policy-binding PROJECT_ID \
  --member=user:YOUR_EMAIL \
  --role=roles/iap.tunnelResourceAccessor

gcloud projects add-iam-policy-binding PROJECT_ID \
  --member=user:YOUR_EMAIL \
  --role=roles/compute.instanceAdmin.v1
```

Connect with:

```bash
gcloud compute ssh paxiom-console --zone=us-central1-a --tunnel-through-iap
```

## VM setup

```bash
sudo apt update && sudo apt upgrade -y
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs git nginx certbot python3-certbot-nginx

sudo useradd --system --create-home --shell /usr/sbin/nologin paxiom
sudo mkdir -p /opt/paxiom /etc/paxiom /var/lib/paxiom /var/log/paxiom
sudo chown -R paxiom:paxiom /opt/paxiom /var/lib/paxiom /var/log/paxiom
```

Clone or deploy the repo to `/opt/paxiom`, then install dependencies:

```bash
sudo -u paxiom git clone https://github.com/k-luecke/paxiom.git /opt/paxiom
cd /opt/paxiom
sudo -u paxiom npm install
```

For a private GitHub repo, use a read-only deploy key scoped to this repository
instead of a personal access token:

```bash
sudo -u paxiom mkdir -p /home/paxiom/.ssh
sudo -u paxiom ssh-keygen -t ed25519 -f /home/paxiom/.ssh/id_ed25519 -N ""
sudo cat /home/paxiom/.ssh/id_ed25519.pub
sudo -u paxiom git clone git@github.com:k-luecke/paxiom.git /opt/paxiom
```

Copy the environment template and set your wallet:

```bash
sudo cp /opt/paxiom/deploy/env/paxiom.env.example /etc/paxiom/paxiom.env
sudo nano /etc/paxiom/paxiom.env
sudo chmod 640 /etc/paxiom/paxiom.env
sudo chown root:paxiom /etc/paxiom/paxiom.env
```

At minimum set:

```bash
PAXIOM_ALLOWED_WALLETS=0xYourMetaMaskAddress
```

## systemd services

```bash
sudo cp /opt/paxiom/deploy/systemd/paxiom@.service /etc/systemd/system/paxiom@.service
sudo systemctl daemon-reload

sudo systemctl enable --now \
  paxiom@catalog \
  paxiom@sync-committee \
  paxiom@load-network \
  paxiom@arb-engine \
  paxiom@compliance \
  paxiom@slot-storage-proof \
  paxiom@cross-chain-message \
  paxiom@simulation \
  paxiom@historical-state \
  paxiom@ui
```

Check status:

```bash
systemctl --no-pager --failed
systemctl status paxiom@ui
curl http://127.0.0.1:3000/healthz
```

For service logs:

```bash
journalctl -u paxiom@catalog -n 100 --no-pager
journalctl -u paxiom@ui -f
journalctl -u 'paxiom@*' -f
```

Services log to stdout/stderr and are intended to be read through journald.
`/var/log/paxiom` is reserved for future file logs; if services start writing
there, add logrotate before treating that path as production-owned storage.

## Nginx and HTTPS

This section is for the direct-VM deployment where Nginx terminates public TLS
on the VM. If you choose Google IAP for browser access through an external HTTPS
load balancer, skip the Certbot step here and use the load balancer's
Google-managed certificate instead.

```bash
sudo cp /opt/paxiom/deploy/nginx/paxiom-console.conf /etc/nginx/sites-available/paxiom-console
sudo ln -s /etc/nginx/sites-available/paxiom-console /etc/nginx/sites-enabled/paxiom-console
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t
sudo systemctl reload nginx
```

Create a DNS `A` record for `console.paxiom.org` pointing to the reserved
static IP. If DNS is managed at Namecheap, set:

- Type: `A`
- Host: `console`
- Value: the reserved static IP
- TTL: `Automatic`

Wait for DNS before requesting a certificate:

```bash
dig console.paxiom.org +short
```

After it returns the static IP:

```bash
sudo certbot --nginx -d console.paxiom.org
systemctl list-timers | grep certbot
```

If `dig console.paxiom.org +short` returns nothing right after a DNS change,
`dig console.paxiom.org +trace` can help distinguish propagation lag from a bad
record.

## Access control

The UI rejects wallets not listed in `PAXIOM_ALLOWED_WALLETS`. For a stronger
private gate, add one of the browser-access controls below.

### Option A: Wallet allowlist only

This is already wired into the app and is enough for the first private operator
test if the console URL is not broadly advertised. It relies on the app's
MetaMask challenge flow being correct.

### Option B: Cloudflare Access

This is the lightest second gate. Keep the VM, Nginx, systemd services, and
Certbot shape above. Move DNS through Cloudflare and create an Access policy for
`console.paxiom.org` that admits only the operator Google account or email.

### Option C: Google IAP for browser access

Google IAP for SSH and Google IAP for browser traffic are different products in
practice. IAP SSH uses TCP forwarding and works directly with the VM. IAP for
the web console normally sits on an external HTTPS load balancer backend.

This is a medium one-time infrastructure addition, not an app rewrite:

1. Put `paxiom-console` into an unmanaged instance group.
2. Create an external HTTPS load balancer with that group as the backend.
3. Attach a Google-managed certificate for `console.paxiom.org`.
4. Point DNS at the load balancer IP instead of the VM static IP.
5. Keep Nginx on the VM listening on plain HTTP and proxying to `127.0.0.1:3000`.
6. Enable IAP on the load balancer backend service.
7. Grant the operator account `roles/iap.httpsResourceAccessor`.

The app, systemd units, environment file, service ports, and wallet allowlist do
not change. The tradeoff is operational: there is another layer to health-check
and debug, plus load-balancer cost and dependency on Google-managed certs/IAP.

Do not run both VM-side Certbot TLS and load-balancer TLS for this first setup.
If you already ran Certbot before choosing Option C, delete the VM certificate
and restore Nginx to plain HTTP before moving DNS to the load balancer:

```bash
sudo certbot delete --cert-name console.paxiom.org
sudo cp /opt/paxiom/deploy/nginx/paxiom-console.conf /etc/nginx/sites-available/paxiom-console
sudo nginx -t
sudo systemctl reload nginx
```

The `cp` command restores the plain-HTTP Nginx config from the repo. If you
hand-edited the live Nginx config after deployment, reconcile those changes
before overwriting it.

The load balancer backend health check should target the VM's HTTP port and a
path Nginx proxies to the UI, such as `/healthz`. The provided Nginx config
proxies all paths to `127.0.0.1:3000`, so `/healthz` reaches the UI service.

## Reference deploy files

The deploy steps above expect these files to exist in the repo:

- `/opt/paxiom/deploy/systemd/paxiom@.service`
- `/opt/paxiom/deploy/bin/paxiom-service-entrypoint.sh`
- `/opt/paxiom/deploy/nginx/paxiom-console.conf`
- `/opt/paxiom/deploy/env/paxiom.env.example`

The shipped systemd template calls a small launcher that maps the instance name
to the correct Node entrypoint and then `exec`s Node directly. This keeps `npm`
out of the process tree for cleaner signal handling during deploys and service
restarts.

```ini
[Unit]
Description=Paxiom %i service
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=paxiom
Group=paxiom
WorkingDirectory=/opt/paxiom
EnvironmentFile=/etc/paxiom/paxiom.env
ExecStart=/bin/sh /opt/paxiom/deploy/bin/paxiom-service-entrypoint.sh %i
Restart=always
RestartSec=5
KillMode=mixed
KillSignal=SIGTERM
TimeoutStopSec=20
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/var/lib/paxiom /var/log/paxiom
SyslogIdentifier=paxiom-%i

[Install]
WantedBy=multi-user.target
```

The launcher maps the template instance to a concrete file:

```sh
#!/bin/sh
set -eu

service="${1:-}"

case "$service" in
  ui) entrypoint="ui/server.js" ;;
  catalog) entrypoint="services/catalog/server.mjs" ;;
  sync-committee) entrypoint="services/sync-committee/server.mjs" ;;
  load-network) entrypoint="services/load-network/server.mjs" ;;
  arb-engine) entrypoint="services/arb-engine/server.mjs" ;;
  compliance) entrypoint="services/compliance/server.mjs" ;;
  slot-storage-proof) entrypoint="services/slot-storage-proof/server.mjs" ;;
  cross-chain-message) entrypoint="services/cross-chain-message/server.mjs" ;;
  simulation) entrypoint="services/simulation/server.mjs" ;;
  historical-state) entrypoint="services/historical-state/server.mjs" ;;
  *)
    echo "unknown Paxiom service: $service" >&2
    exit 64
    ;;
esac

exec /usr/bin/node "$entrypoint"
```

The shipped direct-VM Nginx config is intentionally plain HTTP. Certbot mutates
this file when Nginx terminates TLS directly on the VM; the load-balancer/IAP
path should keep it in this plain-HTTP shape.

```nginx
map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      close;
}

server {
    listen 80;
    server_name console.paxiom.org;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        proxy_read_timeout 300s;
        proxy_send_timeout 300s;
    }
}
```
