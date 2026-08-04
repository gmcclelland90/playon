#!/usr/bin/env bash
# Copy to PlayOn Home bundle root as start-playon.sh (package-home does this).
# Windows counterpart: Start-PlayOn.ps1
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
NODE="${ROOT}/runtime/node/bin/node"
if [[ ! -x "${NODE}" ]]; then
  echo "Bundled Node not found at runtime/node/bin/node"
  echo "Re-download the Linux PlayOn Home package, or run:"
  echo "  node deploy/portable/start-home.mjs"
  exit 1
fi
exec "${NODE}" "${ROOT}/deploy/portable/start-home.mjs"
