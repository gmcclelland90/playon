#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/dist-package"
STAGE="$OUT/playon"

rm -rf "$OUT"
mkdir -p "$STAGE"

# Ship source + lockfile; install happens on the host (Node 22 required).
rsync -a --exclude node_modules --exclude .git --exclude dist --exclude '**/data' \
  --exclude dist-package --exclude '*.sqlite' --exclude '*.db' \
  "$ROOT/" "$STAGE/" 2>/dev/null || {
  # Fallback when rsync is unavailable (e.g. minimal CI images still have cp).
  mkdir -p "$STAGE"
  tar -C "$ROOT" \
    --exclude=node_modules --exclude=.git --exclude=dist --exclude=dist-package \
    --exclude='*.sqlite' --exclude='*.db' \
    -cf - . | tar -C "$STAGE" -xf -
}

cat > "$STAGE/INSTALL.md" <<'EOF'
# PlayOn MVP install

## Prerequisites

- Node.js 22 LTS
- pnpm 9 (`corepack enable && corepack prepare pnpm@9.15.4 --activate`)
- Docker Desktop / Engine optional (required for real Minecraft Paper containers)

## Setup

```bash
pnpm install
pnpm verify
pnpm dev
```

- Web UI: http://127.0.0.1:5173
- API: http://127.0.0.1:8787

Default test/dev modes use `PLAYON_LLM_MODE=mock` and `PLAYON_RUNTIME=mock`.
Set `PLAYON_RUNTIME=docker` when Docker is available for container skills.
EOF

(
  cd "$OUT"
  if command -v zip >/dev/null 2>&1; then
    zip -qr playon-mvp.zip playon
  else
    tar -czf playon-mvp.tar.gz playon
    # CI expects a zip name; create a zip-compatible archive via python when needed.
    python3 - <<'PY'
import pathlib, zipfile
root = pathlib.Path("playon")
with zipfile.ZipFile("playon-mvp.zip", "w", zipfile.ZIP_DEFLATED) as z:
    for path in root.rglob("*"):
        if path.is_file():
            z.write(path, path.as_posix())
print("wrote playon-mvp.zip")
PY
  fi
)

echo "Packaged MVP at $OUT/playon-mvp.zip"
