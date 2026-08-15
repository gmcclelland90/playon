#!/usr/bin/env bash
# PlayOn Home — native install-as-service (control plane + local node-agent). Docker optional.
# Prefer portable ./start-playon.sh for try-tonight; this script installs systemd units.
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

if [[ ! -f "${BUNDLE_ROOT}/apps/api/dist/index.js" ]]; then
  echo "Could not find apps/api/dist/index.js under ${BUNDLE_ROOT}"
  exit 1
fi

echo "==> PlayOn Home install → ${PLAYON_ROOT}"

if ! id -u "${PLAYON_USER}" >/dev/null 2>&1; then
  useradd --system --create-home --home-dir "/home/${PLAYON_USER}" --shell /usr/sbin/nologin "${PLAYON_USER}" || true
fi

BUNDLE_NODE="${BUNDLE_ROOT}/runtime/node/bin/node"
if [[ -x "${BUNDLE_NODE}" ]]; then
  echo "Bundled Node found — will use ${PLAYON_ROOT}/runtime/node/bin/node after copy"
elif command -v node >/dev/null 2>&1; then
  major="$(node -p "process.versions.node.split('.')[0]")"
  if [[ "${major}" -lt 22 ]]; then
    echo "System Node $(node -v) is too old; need 22+ or a portable package with runtime/node."
    exit 1
  fi
  echo "Using system Node $(node -v)"
else
  echo "Installing Node.js 22..."
  if command -v apt-get >/dev/null 2>&1; then
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
    apt-get install -y nodejs
  else
    echo "Install Node.js 22+ manually, then re-run — or use a portable Home package with runtime/node."
    exit 1
  fi
fi

mkdir -p "${PLAYON_ROOT}" "${PLAYON_DATA}" /etc/playon
if command -v rsync >/dev/null 2>&1; then
  rsync -a --delete \
    --exclude .git \
    --exclude data \
    "${BUNDLE_ROOT}/" "${PLAYON_ROOT}/"
else
  find "${PLAYON_ROOT}" -mindepth 1 -maxdepth 1 ! -name data -exec rm -rf {} +
  cp -a "${BUNDLE_ROOT}/." "${PLAYON_ROOT}/"
fi

if [[ -x "${PLAYON_ROOT}/runtime/node/bin/node" ]]; then
  NODE_BIN="${PLAYON_ROOT}/runtime/node/bin/node"
else
  NODE_BIN="$(command -v node)"
fi


HAS_MODULES=0
if [[ -d "${PLAYON_ROOT}/node_modules" || -d "${PLAYON_ROOT}/apps/api/node_modules" ]]; then
  HAS_MODULES=1
fi

if [[ "${HAS_MODULES}" -eq 0 ]]; then
  echo "==> pnpm install --prod"
  corepack enable >/dev/null 2>&1 || true
  corepack prepare pnpm@9.15.4 --activate
  chown -R "${PLAYON_USER}:${PLAYON_USER}" "${PLAYON_ROOT}" "${PLAYON_DATA}"
  cd "${PLAYON_ROOT}"
  sudo -u "${PLAYON_USER}" pnpm install --prod --frozen-lockfile=false
else
  echo "==> Vendored node_modules present — skipping pnpm install"
fi

chown -R "${PLAYON_USER}:${PLAYON_USER}" "${PLAYON_ROOT}" "${PLAYON_DATA}"

ADVERTISE="${PLAYON_ADVERTISE_HOST:-}"
if [[ -z "${ADVERTISE}" ]]; then
  ADVERTISE="$(hostname -I 2>/dev/null | awk '{print $1}')"
  ADVERTISE="${ADVERTISE:-127.0.0.1}"
fi
SESSION_SECRET="${PLAYON_SESSION_SECRET:-$(openssl rand -hex 32 2>/dev/null || head -c 32 /dev/urandom | xxd -p -c 32)}"
NODE_TOKEN="${PLAYON_NODE_TOKEN:-$(openssl rand -hex 24 2>/dev/null || head -c 24 /dev/urandom | xxd -p -c 24)}"
RUNTIME="${PLAYON_RUNTIME:-native}"
ENSURE_DOCKER_SH="${SCRIPT_DIR}/lib/ensure-docker.sh"
if [[ -f "${ENSURE_DOCKER_SH}" ]]; then
  # shellcheck source=lib/ensure-docker.sh
  source "${ENSURE_DOCKER_SH}"
  playon_ensure_docker || true
fi
# Prefer docker when Engine is available and user did not force native
if [[ -S /var/run/docker.sock && -z "${PLAYON_RUNTIME:-}" ]]; then
  RUNTIME=docker
elif [[ -S /var/run/docker.sock && "${PLAYON_RUNTIME:-}" != "native" && "${RUNTIME}" != "native" ]]; then
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
PLAYON_CATALOG_ROOT=${PLAYON_ROOT}/catalog
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
ExecStart=${NODE_BIN} apps/api/dist/index.js
Restart=always
RestartSec=5
# Keep OTA/apply helpers alive when the main process exits for self-update.
KillMode=process
LimitNOFILE=65535
# Prefer :80 for http://playon.local (falls back to PLAYON_PORT without this).
AmbientCapabilities=CAP_NET_BIND_SERVICE
CapabilityBoundingSet=CAP_NET_BIND_SERVICE
NoNewPrivileges=true

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
ExecStart=${NODE_BIN} apps/node-agent/dist/index.js
Restart=always
RestartSec=5
# Only the agent MAINPID — never SIGTERM the supervised game tree on OTA/restart (#886).
KillMode=process
SendSIGHUP=no

[Install]
WantedBy=multi-user.target
EOF

# Allow docker group if present (ensure-docker also adds; keep for already-present Engine)
if getent group docker >/dev/null 2>&1; then
  usermod -aG docker "${PLAYON_USER}" || true
fi

systemctl daemon-reload
# Start Docker before node-agent when available so the first heartbeat sees the socket
if command -v systemctl >/dev/null 2>&1 && systemctl list-unit-files docker.service >/dev/null 2>&1; then
  systemctl enable --now docker.service 2>/dev/null || true
fi
systemctl enable --now playon.service playon-node.service

echo ""
echo "PlayOn Home is up."
echo "  Open:   http://playon.local"
echo "  Fallback: http://${ADVERTISE}:8787 (or :80 if privileged bind worked)"
echo "  After Discord link (Settings → Panel URL): https://<handle>.playon.games"
echo "  Data:   ${PLAYON_DATA}"
echo "  Env:    ${ENV_FILE}"
echo "  Node:   ${NODE_BIN}"
echo "  Runtime:${RUNTIME}"
echo "Add a LAN node with:"
echo "  curl -fsSL https://playon.games/install-node | bash -s -- --api http://${ADVERTISE}:8787 --token ${NODE_TOKEN}"
