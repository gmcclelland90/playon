#!/usr/bin/env bash
# Install Valve SteamCMD for PlayOn native/Steam game servers (Rust, etc.).
set -euo pipefail

USER_HOME="${PLAYON_HOME:-/home/playon}"
INSTALL_ROOT="${PLAYON_STEAMCMD_HOME:-$USER_HOME/steamcmd}"
ENV_FILE="${PLAYON_ENV_FILE:-/etc/playon/playon.env}"

if [[ "$(id -u)" -eq 0 ]]; then
  echo "run as the playon user (not root), or set PLAYON_HOME"
  exit 1
fi

mkdir -p "$INSTALL_ROOT"
cd "$INSTALL_ROOT"

if [[ ! -x "$INSTALL_ROOT/steamcmd.sh" ]]; then
  echo "Downloading SteamCMD into $INSTALL_ROOT ..."
  curl -fsSL "https://steamcdn-a.akamaihd.net/client/installer/steamcmd_linux.tar.gz" -o steamcmd_linux.tar.gz
  tar -xzf steamcmd_linux.tar.gz
  rm -f steamcmd_linux.tar.gz
  chmod +x steamcmd.sh
fi

echo "Bootstrapping SteamCMD (self-update) ..."
./steamcmd.sh +quit || true

if [[ ! -x "$INSTALL_ROOT/steamcmd.sh" ]]; then
  echo "steamcmd.sh missing after install"
  exit 1
fi

echo "SteamCMD ready: $INSTALL_ROOT/steamcmd.sh"

if [[ -w "$ENV_FILE" ]] || [[ -w "$(dirname "$ENV_FILE")" ]]; then
  if grep -q '^PLAYON_STEAMCMD=' "$ENV_FILE" 2>/dev/null; then
    sed -i "s|^PLAYON_STEAMCMD=.*|PLAYON_STEAMCMD=$INSTALL_ROOT/steamcmd.sh|" "$ENV_FILE"
  else
    printf '\nPLAYON_STEAMCMD=%s\nPLAYON_STEAMCMD_AUTO=1\n' "$INSTALL_ROOT/steamcmd.sh" >>"$ENV_FILE"
  fi
  echo "Updated $ENV_FILE"
else
  echo "Add to $ENV_FILE (needs write access):"
  echo "  PLAYON_STEAMCMD=$INSTALL_ROOT/steamcmd.sh"
  echo "  PLAYON_STEAMCMD_AUTO=1"
fi
