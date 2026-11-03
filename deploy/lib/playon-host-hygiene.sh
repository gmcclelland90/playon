# Host hygiene for PlayOn server nodes (#1038 / #1045).
# Source from install.sh / install-node.sh / blank-node bootstrap (root).
#
# - needrestart must not bounce playon units after unattended-upgrades
# - linger so systemd-run --user can fork playon-server-*.service
# - user slice + reference unit so games live outside playon.service

playon_install_needrestart_override() {
  local dest="/etc/needrestart/conf.d/playon.conf"
  mkdir -p /etc/needrestart/conf.d
  if [[ -n "${PLAYON_NEEDRESTART_SRC:-}" && -f "${PLAYON_NEEDRESTART_SRC}" ]]; then
    cp "${PLAYON_NEEDRESTART_SRC}" "${dest}"
  else
    cat >"${dest}" <<'EOF'
# PlayOn — do not auto-restart Home or node-agent after library upgrades (#1038 / #1045).
$nrconf{override_rc}{qr(^playon)} = 0;
EOF
  fi
}

playon_enable_user_linger() {
  local user="${1:-playon}"
  if command -v loginctl >/dev/null 2>&1; then
    loginctl enable-linger "${user}" 2>/dev/null || true
  fi
}

playon_install_user_slice() {
  local user="${1:-playon}"
  local dest="/etc/systemd/user/playon.slice"
  mkdir -p /etc/systemd/user
  if [[ -n "${PLAYON_SLICE_SRC:-}" && -f "${PLAYON_SLICE_SRC}" ]]; then
    cp "${PLAYON_SLICE_SRC}" "${dest}"
  else
    cat >"${dest}" <<'EOF'
# User slice for native games. Never PartOf=playon.service (#1045).
[Unit]
Description=PlayOn native game servers

[Slice]
EOF
  fi
  local home=""
  if command -v getent >/dev/null 2>&1; then
    home="$(getent passwd "${user}" | cut -d: -f6 || true)"
  fi
  if [[ -n "${home}" && "${home}" != "/" ]]; then
    mkdir -p "${home}/.config/systemd/user"
    cp "${dest}" "${home}/.config/systemd/user/playon.slice"
    chown -R "${user}:${user}" "${home}/.config/systemd/user" 2>/dev/null || true
  fi
}

playon_install_server_unit() {
  local dest="/etc/systemd/system/playon-server@.service"
  if [[ -n "${PLAYON_SERVER_UNIT_SRC:-}" && -f "${PLAYON_SERVER_UNIT_SRC}" ]]; then
    cp "${PLAYON_SERVER_UNIT_SRC}" "${dest}"
    return
  fi
  cat >"${dest}" <<'EOF'
# Reference only. Runtime uses systemd-run --user. Never PartOf=playon.service (#1045).
[Unit]
Description=PlayOn native game server %i

[Service]
Type=simple
KillMode=control-group
ExecStopPost=-/usr/bin/logger -t playon -- playon_native_unit_stop %n

[Install]
WantedBy=default.target
EOF
}

playon_apply_host_hygiene() {
  local user="${1:-playon}"
  playon_install_needrestart_override
  playon_enable_user_linger "${user}"
  playon_install_user_slice "${user}"
  playon_install_server_unit
}
