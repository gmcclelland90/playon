#!/usr/bin/env bash
# PlayOn Home — one-line installer (Linux x64)
#   curl -fsSL https://playon.games/install | bash
#
# Env (optional):
#   PLAYON_HOME     Install directory (default: $HOME/playon)
#   PLAYON_REPO     GitHub owner/repo (default: gmcclelland90/playon)
#   PLAYON_VERSION  Release tag, e.g. v0.1.0 (default: latest)
#   PLAYON_START    0 to skip launching after install (default: 1)
#   PLAYON_SERVICE  1 to run deploy/install.sh (systemd; requires sudo) (default: 0)

set -euo pipefail

REPO="${PLAYON_REPO:-gmcclelland90/playon}"
HOME_DIR="${PLAYON_HOME:-${HOME}/playon}"
DO_START="${PLAYON_START:-1}"
AS_SERVICE="${PLAYON_SERVICE:-0}"
api() {
  local url="$1"
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL -H "Accept: application/vnd.github+json" -H "User-Agent: PlayOn-Install" "$url"
  else
    wget -qO- --header="Accept: application/vnd.github+json" --header="User-Agent: PlayOn-Install" "$url"
  fi
}

download() {
  local url="$1" dest="$2"
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL -o "$dest" "$url"
  else
    wget -qO "$dest" "$url"
  fi
}

echo "==> PlayOn Home install"
echo "    Repo: ${REPO}"
echo "    Dir:  ${HOME_DIR}"

if [[ -n "${PLAYON_VERSION:-}" ]]; then
  TAG="${PLAYON_VERSION}"
  [[ "${TAG}" == v* ]] || TAG="v${TAG}"
  RELEASE_JSON="$(api "https://api.github.com/repos/${REPO}/releases/tags/${TAG}")"
else
  RELEASE_JSON="$(api "https://api.github.com/repos/${REPO}/releases/latest")"
fi

TAG_NAME="$(printf '%s' "${RELEASE_JSON}" | sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n1)"
# Prefer python/jq if present for robust JSON; fall back to sed+grep.
ASSET_URL=""
ASSET_NAME=""
if command -v jq >/dev/null 2>&1; then
  ASSET_NAME="$(printf '%s' "${RELEASE_JSON}" | jq -r '.assets[] | select(.name | test("playon-home-.*-linux-x64\\.tar\\.gz")) | .name' | head -n1)"
  ASSET_URL="$(printf '%s' "${RELEASE_JSON}" | jq -r '.assets[] | select(.name | test("playon-home-.*-linux-x64\\.tar\\.gz")) | .browser_download_url' | head -n1)"
elif command -v python3 >/dev/null 2>&1; then
  eval "$(printf '%s' "${RELEASE_JSON}" | python3 -c '
import json,sys,re
r=json.load(sys.stdin)
pat=re.compile(r"playon-home-.*-linux-x64\.tar\.gz")
for a in r.get("assets",[]):
  if pat.search(a.get("name","")):
    print("ASSET_NAME="+repr(a["name"]))
    print("ASSET_URL="+repr(a["browser_download_url"]))
    break
')"
else
  ASSET_NAME="$(printf '%s' "${RELEASE_JSON}" | tr ',' '\n' | sed -n 's/.*"name"[[:space:]]*:[[:space:]]*"\(playon-home-[^"]*-linux-x64\.tar\.gz\)".*/\1/p' | head -n1)"
  ASSET_URL="$(printf '%s' "${RELEASE_JSON}" | tr ',' '\n' | sed -n 's/.*"browser_download_url"[[:space:]]*:[[:space:]]*"\([^"]*'"${ASSET_NAME}"'\)".*/\1/p' | head -n1)"
  # Last-resort: construct from tag if name known
  if [[ -n "${ASSET_NAME}" && -z "${ASSET_URL}" ]]; then
    ASSET_URL="https://github.com/${REPO}/releases/download/${TAG_NAME}/${ASSET_NAME}"
  fi
fi

if [[ -z "${ASSET_URL}" || -z "${ASSET_NAME}" || "${ASSET_URL}" == "null" ]]; then
  echo "No linux-x64 Home asset on release ${TAG_NAME:-unknown}. Publish a Home package first."
  exit 1
fi

STAGING="$(mktemp -d "${TMPDIR:-/tmp}/playon-home.XXXXXX")"
cleanup() { rm -rf "${STAGING}"; }
trap cleanup EXIT

ARCHIVE="${STAGING}/${ASSET_NAME}"
echo "==> Downloading ${ASSET_NAME} (${TAG_NAME})"
download "${ASSET_URL}" "${ARCHIVE}"

echo "==> Extracting"
tar -xzf "${ARCHIVE}" -C "${STAGING}"
EXTRACTED="${STAGING}/playon"
if [[ ! -f "${EXTRACTED}/start-playon.sh" ]]; then
  script_path="$(find "${STAGING}" -maxdepth 2 -type f -name start-playon.sh | head -n1 || true)"
  if [[ -n "${script_path}" ]]; then
    EXTRACTED="$(cd "$(dirname "${script_path}")" && pwd)"
  fi
fi
if [[ -z "${EXTRACTED}" || ! -f "${EXTRACTED}/start-playon.sh" ]]; then
  echo "Extracted archive missing start-playon.sh"
  exit 1
fi

mkdir -p "$(dirname "${HOME_DIR}")"
if [[ -d "${HOME_DIR}" ]]; then
  echo "==> Updating ${HOME_DIR} (keeping data/ and env/)"
  shopt -s dotglob nullglob
  for item in "${EXTRACTED}"/*; do
    base="$(basename "${item}")"
    if [[ "${base}" == "data" || "${base}" == "env" ]] && [[ -e "${HOME_DIR}/${base}" ]]; then
      continue
    fi
    rm -rf "${HOME_DIR:?}/${base}"
    cp -a "${item}" "${HOME_DIR}/"
  done
  shopt -u dotglob nullglob
else
  cp -a "${EXTRACTED}" "${HOME_DIR}"
fi

chmod +x "${HOME_DIR}/start-playon.sh" 2>/dev/null || true
echo "==> Installed ${TAG_NAME} → ${HOME_DIR}"

if [[ "${AS_SERVICE}" == "1" ]]; then
  echo "==> Installing systemd units (sudo)"
  sudo bash "${HOME_DIR}/deploy/install.sh"
  exit 0
fi

if [[ "${DO_START}" != "0" ]]; then
  echo "==> Starting PlayOn"
  cd "${HOME_DIR}"
  exec ./start-playon.sh
else
  echo "Start later with:"
  echo "  ${HOME_DIR}/start-playon.sh"
fi
