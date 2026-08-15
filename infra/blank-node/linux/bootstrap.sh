#!/usr/bin/env bash
# Bootstrap an existing Ubuntu/Debian host as a PlayOn blank node.
# Usage (root):
#   PLAYON_API_URL=http://192.168.1.10:8787 PLAYON_NODE_TOKEN=secret \
#   PLAYON_NODE_ID=lab-1 bash bootstrap.sh
set -euo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run as root (sudo)." >&2
  exit 1
fi

: "${PLAYON_API_URL:?Set PLAYON_API_URL to the control-plane API base URL}"
: "${PLAYON_NODE_TOKEN:?Set PLAYON_NODE_TOKEN to match the control plane}"

PLAYON_NODE_ID="${PLAYON_NODE_ID:-$(hostname -s)}"
PLAYON_NODE_NAME="${PLAYON_NODE_NAME:-$(hostname -s)}"
PLAYON_DATA_ROOT="${PLAYON_DATA_ROOT:-/var/lib/playon}"
PLAYON_REPO="${PLAYON_REPO:-/opt/playon}"
PLAYON_HEARTBEAT_MS="${PLAYON_HEARTBEAT_MS:-5000}"

export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y curl ca-certificates gnupg git jq

if ! command -v docker >/dev/null 2>&1; then
  curl -fsSL https://get.docker.com | sh
  systemctl enable --now docker
fi

if ! command -v node >/dev/null 2>&1 || [[ "$(node -v | cut -d. -f1 | tr -d v)" -lt 22 ]]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi

if ! command -v pnpm >/dev/null 2>&1; then
  npm install -g pnpm@9
fi

mkdir -p "${PLAYON_DATA_ROOT}" /etc/playon
cat >/etc/playon/node.env <<EOF
PLAYON_API_URL=${PLAYON_API_URL}
PLAYON_NODE_TOKEN=${PLAYON_NODE_TOKEN}
PLAYON_NODE_ID=${PLAYON_NODE_ID}
PLAYON_NODE_NAME=${PLAYON_NODE_NAME}
PLAYON_DATA_ROOT=${PLAYON_DATA_ROOT}
PLAYON_HEARTBEAT_MS=${PLAYON_HEARTBEAT_MS}
EOF
chmod 600 /etc/playon/node.env

if [[ ! -f "${PLAYON_REPO}/package.json" ]]; then
  echo "PlayOn repo not found at ${PLAYON_REPO}."
  echo "Copy or clone the monorepo there, then re-run this script."
  echo "Example: git clone <your-playon-url> ${PLAYON_REPO}"
  exit 2
fi

cd "${PLAYON_REPO}"
pnpm install --filter @playon/node-agent...
pnpm --filter @playon/node-agent build

cat >/etc/systemd/system/playon-node-agent.service <<EOF
[Unit]
Description=PlayOn node-agent
After=network-online.target docker.service
Wants=network-online.target

[Service]
Type=simple
EnvironmentFile=/etc/playon/node.env
WorkingDirectory=${PLAYON_REPO}
ExecStart=$(command -v pnpm) --filter @playon/node-agent start
Restart=always
RestartSec=5
# Only the agent MAINPID — never SIGTERM the supervised game tree on OTA/restart (#886).
KillMode=process
SendSIGHUP=no

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now playon-node-agent.service
systemctl --no-pager --full status playon-node-agent.service || true

echo "Blank node ready. Heartbeats → ${PLAYON_API_URL} as ${PLAYON_NODE_ID}"
