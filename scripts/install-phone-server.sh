#!/usr/bin/env bash
# One-time setup on the 5090: run Meander's server at boot and publish it to
# your own devices over Tailscale (never the open internet).
#   bash scripts/install-phone-server.sh
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"

mkdir -p ~/.config/systemd/user
cp "$here/meander.service" ~/.config/systemd/user/meander.service
systemctl --user daemon-reload
systemctl --user enable --now meander.service
# Keep it running when you're not logged in to the desktop.
loginctl enable-linger "$USER" 2>/dev/null || sudo loginctl enable-linger "$USER"

# Wait for the server, then share it on your tailnet.
for _ in $(seq 1 60); do curl -fs http://127.0.0.1:8710/manifest.webmanifest >/dev/null && break; sleep 1; done
tailscale serve --bg --http=80 http://127.0.0.1:8710 2>/dev/null \
  || { sudo tailscale set --operator="$USER"; tailscale serve --bg --http=80 http://127.0.0.1:8710; }

host=$(tailscale status --json | python3 -c 'import json,sys;print(json.load(sys.stdin)["Self"]["DNSName"].rstrip("."))')
echo
echo "Meander is running. On your phone (with the Tailscale app on), open:"
echo "  http://$host"
