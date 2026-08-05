#!/usr/bin/env bash
# PlayOn Node — join an existing Home control plane as a remote runtime host.
set -euo pipefail

API_URL=""
NODE_TOKEN=""
NODE_ID=""
PLAYON_ROOT="${PLAYON_ROOT:-/opt/playon-node}"
PLAYON_DATA="${PLAYON_DATA_ROOT:-/var/lib/playon-node}"
PLAYON_USER="${PLAYON_USER:-playon}"
RUNTIME="${PLAYON_RUNTIME:-native}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --api) API_URL="$2"; shift 2 ;;
    --token) NODE_TOKEN="$2"; shift 2 ;;
    --node-id) NODE_ID="$2"; shift 2 ;;
    --runtime) RUNTIME="$2"; shift 2 ;;
    *) echo "Unknown arg: $1"; exit 1 ;;
  esac
done

if [[ -z "${API_URL}" || -z "${NODE_TOKEN}" ]]; then
  echo "Usage: bash install-node.sh --api http://192.168.1.10:8787 --token <PLAYON_NODE_TOKEN> [--node-id spare-1]"
  exit 1
fi

if [[ "$(id -u)" -ne 0 ]]; then
  echo "Run as root"
  exit 1
fi

NODE_ID="${NODE_ID:-$(hostname -s 2>/dev/null || hostname)}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BUNDLE_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
# install-node.sh lives in deploy/; lib is deploy/lib/
ENSURE_DOCKER_SH="${SCRIPT_DIR}/lib/ensure-docker.sh"
if [[ ! -f "${ENSURE_DOCKER_SH}" ]]; then
  ENSURE_DOCKER_SH="${BUNDLE_ROOT}/deploy/lib/ensure-docker.sh"
fi

if ! id -u "${PLAYON_USER}" >/dev/null 2>&1; then
  useradd --system --create-home --home-dir "/home/${PLAYON_USER}" --shell /usr/sbin/nologin "${PLAYON_USER}" || true
fi

if [[ -f "${ENSURE_DOCKER_SH}" ]]; then
  # shellcheck source=lib/ensure-docker.sh
  source "${ENSURE_DOCKER_SH}"
  playon_ensure_docker || true
elif curl -fsSL https://playon.games/ensure-docker -o /tmp/playon-ensure-docker.sh 2>/dev/null; then
  # Published install-node one-liner may not ship deploy/lib next to this script.
  # shellcheck disable=SC1091
  source /tmp/playon-ensure-docker.sh
  playon_ensure_docker || true
fi
if [[ -S /var/run/docker.sock ]]; then
  if [[ "${PLAYON_RUNTIME:-}" != "native" ]]; then
    RUNTIME=docker
  fi
else
  RUNTIME=native
fi

if ! command -v node >/dev/null 2>&1 || [[ "$(node -p "process.versions.node.split('.')[0]")" -lt 22 ]]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi
corepack enable >/dev/null 2>&1 || true
corepack prepare pnpm@9.15.4 --activate

mkdir -p "${PLAYON_ROOT}" "${PLAYON_DATA}" /etc/playon
cp -a "${BUNDLE_ROOT}/." "${PLAYON_ROOT}/"
chown -R "${PLAYON_USER}:${PLAYON_USER}" "${PLAYON_ROOT}" "${PLAYON_DATA}"
cd "${PLAYON_ROOT}"
sudo -u "${PLAYON_USER}" pnpm install --prod --frozen-lockfile=false

if getent group docker >/dev/null 2>&1; then
  usermod -aG docker "${PLAYON_USER}" || true
fi

cat >/etc/playon/node.env <<EOF
PLAYON_API_URL=${API_URL}
PLAYON_NODE_TOKEN=${NODE_TOKEN}
PLAYON_NODE_ID=${NODE_ID}
PLAYON_NODE_NAME=${NODE_ID}
PLAYON_DATA_ROOT=${PLAYON_DATA}
PLAYON_RUNTIME=${RUNTIME}
EOF
chmod 600 /etc/playon/node.env

cat >/etc/systemd/system/playon-node-agent.service <<EOF
[Unit]
Description=PlayOn node-agent
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${PLAYON_USER}
Group=${PLAYON_USER}
EnvironmentFile=/etc/playon/node.env
WorkingDirectory=${PLAYON_ROOT}
ExecStart=/usr/bin/pnpm --filter @playon/node-agent start
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now playon-node-agent.service
echo "Node ${NODE_ID} joining ${API_URL} (runtime=${RUNTIME})"
