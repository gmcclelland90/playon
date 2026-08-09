#!/usr/bin/env bash
# Standing lab cadence on playon-dev (24/7): pull → merge bar → matrix → file issues.
# Installed via infra/lab/playon-lab-cadence.{service,timer}
set -euo pipefail

ROOT="${PLAYON_LAB_GIT_ROOT:-/home/playon/src/playon-git}"
cd "$ROOT"

if [[ -f /etc/playon/playon.env ]]; then
  set -a
  # shellcheck disable=SC1091
  . /etc/playon/playon.env
  set +a
fi

export PLAYON_LAB_FILE_ISSUES="${PLAYON_LAB_FILE_ISSUES:-1}"
export PLAYON_LLM_MODE="${PLAYON_LLM_MODE:-openai_compatible}"
export PLAYON_RUNTIME="${PLAYON_RUNTIME:-docker}"

git pull --ff-only
pnpm install --frozen-lockfile || pnpm install

# Merge bar first (fire rule). On red, issues are filed; stop before matrix.
if ! pnpm loop:verify; then
  echo "merge bar red — matrix skipped this cadence tick"
  exit 1
fi

# Full catalog matrix; continue-on-fail so one skill does not hide the rest, then file all.
pnpm lab:matrix --continue-on-fail || true
node scripts/lab-file-github-issues.mjs --from matrix || true

echo "lab cadence tick complete"
