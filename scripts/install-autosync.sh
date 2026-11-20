#!/usr/bin/env bash
# One-time setup on the 5090: daily unattended upstream sync + release
# (scripts/auto-upstream.sh), and the port-reclaim fix for meander.service so
# released updates actually land on this PC's server.
#   bash scripts/install-autosync.sh
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
runner=~/projects/meander-autosync-runner

# The runner is its own checkout of main, refreshed before each run, so the
# script that runs is always the latest committed one.
[ -d "$runner/.git" ] || git clone -q https://github.com/vinceychu/meander.git "$runner"
git -C "$runner" fetch -q origin main && git -C "$runner" reset -q --hard origin/main

mkdir -p ~/.config/systemd/user/meander-autosync.service.d ~/.local/share/meander
install -m 755 "$here/meander-reclaim-port.sh" ~/.local/share/meander/meander-reclaim-port.sh
cp "$here/meander.service" ~/.config/systemd/user/meander.service
cp "$here/meander-autosync.service" "$here/meander-autosync.timer" ~/.config/systemd/user/
cat > ~/.config/systemd/user/meander-autosync.service.d/refresh.conf <<CONF
[Service]
ExecStartPre=/usr/bin/git -C $runner fetch -q origin main
ExecStartPre=/usr/bin/git -C $runner reset -q --hard origin/main
CONF
systemctl --user daemon-reload
systemctl --user enable --now meander-autosync.timer
systemctl --user restart meander.service
loginctl enable-linger "$USER" 2>/dev/null || true
systemctl --user list-timers meander-autosync.timer --no-pager
