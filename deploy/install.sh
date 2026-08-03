#!/usr/bin/env bash
# PlayOn Home — native install (control plane + local node-agent). Docker optional.
set -euo pipefail

PLAYON_ROOT="${PLAYON_ROOT:-/opt/playon}"
PLAYON_DATA="${PLAYON_DATA_ROOT:-/var/lib/playon}"
PLAYON_USER="${PLAYON_USER:-playon}"
ENV_FILE="${PLAYON_ENV_FILE:-/etc/playon/playon.env}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Prefer running from extracted Home tarball (parent of deploy/)
BUNDLE_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

if [[ "$(id -u)" -ne 0 ]]; then
  echo "Run as root (sudo bash deploy/install.sh)"
  exit 1
fi

echo "==> PlayOn Home install → ${PLAYON_ROOT}"

if ! id -u "${PLAYON_USER}" >/dev/null 2>&1; then
  useradd --system --create-home --home-dir "/home/${PLAYON_USER}" --shell /usr/sbin/nologin "${PLAYON_USER}" || true
fi

install_node() {
  if command -v node >/dev/null 2>&1; then
    local major
    major="$(node -p "process.versions.node.split('.')[0]")"
    if [[ "${major}" -ge 22 ]]; then
      echo "Node $(node -v) OK"
      return
    fi
  fi
  echo "Installing Node.js 22..."
  if command -v apt-get >/dev/null 2>&1; then
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
    apt-get install -y nodejs
  else
    echo "Install Node.js 22+ manually, then re-run."
    exit 1
  fi
}

install_node
corepack enable >/dev/null 2>&1 || true
corepack prepare pnpm@9.15.4 --activate

mkdir -p "${PLAYON_ROOT}" "${PLAYON_DATA}" /etc/playon
rsync -a --delete \
  --exclude node_modules \
  --exclude .git \
  --exclude data \
  "${BUNDLE_ROOT}/" "${PLAYON_ROOT}/" 2>/dev/null || {
  # Fallback without rsync
  find "${PLAYON_ROOT}" -mindepth 1 -maxdepth 1 ! -name node_modules -exec rm -rf {} +
  cp -a "${BUNDLE_ROOT}/." "${PLAYON_ROOT}/"
}

chown -R "${PLAYON_USER}:${PLAYON_USER}" "${PLAYON_ROOT}" "${PLAYON_DATA}"

echo "==> pnpm install --prod"
cd "${PLAYON_ROOT}"
sudo -u "${PLAYON_USER}" pnpm install --prod --frozen-lockfile=false

ADVERTISE="${PLAYON_ADVERTISE_HOST:-}"
if [[ -z "${ADVERTISE}" ]]; then
  ADVERTISE="$(hostname -I 2>/dev/null | awk '{print $1}')"
  ADVERTISE="${ADVERTISE:-127.0.0.1}"
fi
SESSION_SECRET="${PLAYON_SESSION_SECRET:-$(openssl rand -hex 32 2>/dev/null || head -c 32 /dev/urandom | xxd -p -c 32)}"
NODE_TOKEN="${PLAYON_NODE_TOKEN:-$(openssl rand -hex 24 2>/dev/null || head -c 24 /dev/urandom | xxd -p -c 24)}"
RUNTIME="${PLAYON_RUNTIME:-native}"
# Auto-upgrade to docker mode when Engine socket exists and user did not force native
if [[ "${RUNTIME}" == "native" && -S /var/run/docker.sock && "${PLAYON_RUNTIME:-}" == "" ]]; then
  RUNTIME=docker
fi

cat >"${ENV_FILE}" <<EOF
PLAYON_ENV=production
PLAYON_HOST=0.0.0.0
PLAYON_PORT=8787
PLAYON_ADVERTISE_HOST=${ADVERTISE}
PLAYON_SESSION_SECRET=${SESSION_SECRET}
PLAYON_DATA_ROOT=${PLAYON_DATA}
PLAYON_RUNTIME=${RUNTIME}
PLAYON_LLM_MODE=openai_compatible
PLAYON_NODE_TOKEN=${NODE_TOKEN}
PLAYON_SKILLS_ROOT=${PLAYON_ROOT}/skills
PLAYON_SKILLS_PROFILE=minimal
PLAYON_WEB_DIST=${PLAYON_ROOT}/apps/web/dist
EOF
chmod 600 "${ENV_FILE}"
chown root:${PLAYON_USER} "${ENV_FILE}"

cat >/etc/systemd/system/playon.service <<EOF
[Unit]
Description=PlayOn control plane (API + web)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${PLAYON_USER}
Group=${PLAYON_USER}
EnvironmentFile=${ENV_FILE}
WorkingDirectory=${PLAYON_ROOT}
ExecStart=/usr/bin/pnpm --filter @playon/api start
Restart=always
RestartSec=5
LimitNOFILE=65535

[Install]
WantedBy=multi-user.target
EOF

cat >/etc/systemd/system/playon-node.service <<EOF
[Unit]
Description=PlayOn local node-agent
After=network-online.target playon.service
Wants=network-online.target

[Service]
Type=simple
User=${PLAYON_USER}
Group=${PLAYON_USER}
EnvironmentFile=${ENV_FILE}
Environment=PLAYON_API_URL=http://127.0.0.1:8787
Environment=PLAYON_NODE_ID=local
Environment=PLAYON_NODE_NAME=%H
WorkingDirectory=${PLAYON_ROOT}
ExecStart=/usr/bin/pnpm --filter @playon/node-agent start
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

# Allow docker group if present
if getent group docker >/dev/null 2>&1; then
  usermod -aG docker "${PLAYON_USER}" || true
fi

systemctl daemon-reload
systemctl enable --now playon.service playon-node.service

echo ""
echo "PlayOn Home is up."
echo "  Admin:  http://${ADVERTISE}:8787"
echo "  Data:   ${PLAYON_DATA}"
echo "  Env:    ${ENV_FILE}"
echo "  Runtime:${RUNTIME}"
echo "Add a LAN node with:"
echo "  curl -fsSL https://playon.games/install-node | bash -s -- --api http://${ADVERTISE}:8787 --token ${NODE_TOKEN}"
