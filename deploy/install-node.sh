#!/usr/bin/env bash
# PlayOn Node — join an existing Home control plane as a remote runtime host.
#
# When run from a package tree (or Home checkout), copies that tree.
# When curl'd from playon.games/install-node, downloads the node asset from
# https://playon.games/home/latest.json
set -euo pipefail

API_URL=""
NODE_TOKEN=""
NODE_ID=""
NODE_NAME=""
PLAYON_ROOT="${PLAYON_ROOT:-/opt/playon-node}"
PLAYON_DATA="${PLAYON_DATA_ROOT:-/var/lib/playon-node}"
PLAYON_USER="${PLAYON_USER:-playon}"
RUNTIME="${PLAYON_RUNTIME:-native}"
MANIFEST_URL="${PLAYON_UPDATE_MANIFEST_URL:-https://playon.games/home/latest.json}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --api) API_URL="$2"; shift 2 ;;
    --token) NODE_TOKEN="$2"; shift 2 ;;
    --node-id) NODE_ID="$2"; shift 2 ;;
    --name) NODE_NAME="$2"; shift 2 ;;
    --runtime) RUNTIME="$2"; shift 2 ;;
    *) echo "Unknown arg: $1"; exit 1 ;;
  esac
done

if [[ -z "${API_URL}" || -z "${NODE_TOKEN}" ]]; then
  echo "Usage: bash install-node.sh --api http://192.168.1.10:8787 --token <PLAYON_NODE_TOKEN> [--node-id spare-1] [--name friendly]"
  exit 1
fi

if [[ "$(id -u)" -ne 0 ]]; then
  echo "Run as root"
  exit 1
fi

NODE_ID="${NODE_ID:-$(hostname -s 2>/dev/null || hostname)}"
NODE_NAME="${NODE_NAME:-$(hostname -s 2>/dev/null || hostname)}"
NODE_NAME="${NODE_NAME:-${NODE_ID}}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# When this file lives in deploy/, bundle root is parent; when curl'd to /tmp, no bundle.
if [[ -f "${SCRIPT_DIR}/../apps/node-agent/dist/index.js" ]] || [[ -f "${SCRIPT_DIR}/../package.json" && -d "${SCRIPT_DIR}/../apps/node-agent" ]]; then
  BUNDLE_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
elif [[ -f "${SCRIPT_DIR}/apps/node-agent/dist/index.js" ]]; then
  BUNDLE_ROOT="${SCRIPT_DIR}"
else
  BUNDLE_ROOT=""
fi

ENSURE_DOCKER_SH="${SCRIPT_DIR}/lib/ensure-docker.sh"
if [[ -n "${BUNDLE_ROOT}" && -f "${BUNDLE_ROOT}/deploy/lib/ensure-docker.sh" ]]; then
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

download_from_manifest() {
  echo "==> Fetching node package from ${MANIFEST_URL}"
  local json staging archive url sha name extracted
  json="$(curl -fsSL -H "Accept: application/json" -H "User-Agent: PlayOn-Install-Node" "${MANIFEST_URL}")"
  staging="$(mktemp -d /tmp/playon-node-pkg.XXXXXX)"
  if command -v python3 >/dev/null 2>&1; then
    eval "$(printf '%s' "${json}" | python3 -c '
import json,sys
m=json.load(sys.stdin)
a=(m.get("node") or {}).get("linux-x64") or {}
print("url="+repr(a.get("downloadUrl") or ""))
print("sha="+repr(a.get("sha256") or ""))
')"
  elif command -v jq >/dev/null 2>&1; then
    url="$(printf '%s' "${json}" | jq -r '.node["linux-x64"].downloadUrl // empty')"
    sha="$(printf '%s' "${json}" | jq -r '.node["linux-x64"].sha256 // empty')"
  else
    echo "Need python3 or jq to parse ${MANIFEST_URL}"
    exit 1
  fi
  if [[ -z "${url:-}" || -z "${sha:-}" ]]; then
    echo "No linux-x64 node asset in update manifest. Publish playon-node release + home/latest.json first."
    exit 1
  fi
  name="$(basename "${url}")"
  archive="${staging}/${name}"
  echo "==> Downloading ${name}"
  curl -fsSL -L -o "${archive}" "${url}"
  echo "${sha}  ${archive}" | sha256sum -c -
  echo "==> Extracting"
  tar -xzf "${archive}" -C "${staging}"
  extracted="${staging}/playon-node"
  if [[ ! -f "${extracted}/package.json" ]]; then
    extracted="$(find "${staging}" -maxdepth 2 -type f -name package.json -printf '%h\n' | head -n1)"
  fi
  if [[ -z "${extracted}" || ! -f "${extracted}/apps/node-agent/dist/index.js" ]]; then
    echo "Extracted node package missing apps/node-agent/dist/index.js"
    exit 1
  fi
  BUNDLE_ROOT="${extracted}"
  echo "==> Using downloaded package at ${BUNDLE_ROOT}"
}

if [[ -z "${BUNDLE_ROOT}" || ! -f "${BUNDLE_ROOT}/apps/node-agent/dist/index.js" ]]; then
  download_from_manifest
fi

mkdir -p "${PLAYON_ROOT}" "${PLAYON_DATA}" /etc/playon
# Preserve existing data/env files inside install root if re-running
if [[ -d "${PLAYON_ROOT}" ]]; then
  shopt -s dotglob nullglob
  for item in "${BUNDLE_ROOT}"/*; do
    base="$(basename "${item}")"
    if [[ "${base}" == "data" || "${base}" == "env" || "${base}" == "node.env" || "${base}" == "node.env.cmd" ]] && [[ -e "${PLAYON_ROOT}/${base}" ]]; then
      continue
    fi
    rm -rf "${PLAYON_ROOT:?}/${base}"
    cp -a "${item}" "${PLAYON_ROOT}/"
  done
  shopt -u dotglob nullglob
else
  cp -a "${BUNDLE_ROOT}/." "${PLAYON_ROOT}/"
fi
chown -R "${PLAYON_USER}:${PLAYON_USER}" "${PLAYON_ROOT}" "${PLAYON_DATA}"

# Prefer bundled Node; otherwise system Node 22 + pnpm
NODE_BIN="${PLAYON_ROOT}/runtime/node/bin/node"
if [[ -x "${NODE_BIN}" ]]; then
  EXEC_START="${NODE_BIN} ${PLAYON_ROOT}/apps/node-agent/dist/index.js"
else
  if ! command -v node >/dev/null 2>&1 || [[ "$(node -p "process.versions.node.split('.')[0]")" -lt 22 ]]; then
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
    apt-get install -y nodejs
  fi
  corepack enable >/dev/null 2>&1 || true
  corepack prepare pnpm@9.15.4 --activate
  cd "${PLAYON_ROOT}"
  sudo -u "${PLAYON_USER}" pnpm install --prod --frozen-lockfile=false
  EXEC_START="/usr/bin/pnpm --filter @playon/node-agent start"
fi

if getent group docker >/dev/null 2>&1; then
  usermod -aG docker "${PLAYON_USER}" || true
fi

cat >/etc/playon/node.env <<EOF
PLAYON_API_URL=${API_URL}
PLAYON_NODE_TOKEN=${NODE_TOKEN}
PLAYON_NODE_ID=${NODE_ID}
PLAYON_NODE_NAME=${NODE_NAME}
PLAYON_DATA_ROOT=${PLAYON_DATA}
PLAYON_RUNTIME=${RUNTIME}
PLAYON_INSTALL_ROOT=${PLAYON_ROOT}
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
ExecStart=${EXEC_START}
Restart=always
RestartSec=5
KillMode=process

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now playon-node-agent.service
echo "Node ${NODE_ID} joining ${API_URL} (runtime=${RUNTIME})"
