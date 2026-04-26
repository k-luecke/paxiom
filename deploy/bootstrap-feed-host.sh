#!/usr/bin/env bash
set -euo pipefail

repo_dir="${1:-/opt/paxiom}"

if [[ "$(id -u)" -ne 0 ]]; then
  echo "Run as root: sudo deploy/bootstrap-feed-host.sh [$repo_dir]" >&2
  exit 1
fi

if ! id paxiom >/dev/null 2>&1; then
  useradd --system --create-home --shell /usr/sbin/nologin paxiom
fi

mkdir -p "$repo_dir" /etc/paxiom /var/lib/paxiom
chown -R paxiom:paxiom "$repo_dir" /var/lib/paxiom

install -m 0640 -o root -g paxiom "$repo_dir/deploy/feed-api.env.example" /etc/paxiom/feed-api.env
install -m 0640 -o root -g paxiom "$repo_dir/deploy/live-prover.env.example" /etc/paxiom/live-prover.env

if [[ ! -f /etc/paxiom/subscribers.json ]]; then
  install -m 0640 -o root -g paxiom "$repo_dir/deploy/subscribers.example.json" /etc/paxiom/subscribers.json
fi

install -m 0644 "$repo_dir/deploy/paxiom-feed-api.service" /etc/systemd/system/paxiom-feed-api.service
install -m 0644 "$repo_dir/deploy/paxiom-live-prover.service" /etc/systemd/system/paxiom-live-prover.service

systemctl daemon-reload

echo "Installed Paxiom service files."
echo "Next:"
echo "  cd $repo_dir && npm ci"
echo "  edit /etc/paxiom/feed-api.env and /etc/paxiom/live-prover.env"
echo "  npm run feed:create-subscriber -- --id pilot-uniswap-slot0 --file /etc/paxiom/subscribers.json --scope predicate:uniswap_v3_slot0"
echo "  systemctl enable --now paxiom-live-prover paxiom-feed-api"
