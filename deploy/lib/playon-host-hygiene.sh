# Host hygiene for PlayOn server nodes (#1038).
# Source from install.sh / install-node.sh / blank-node bootstrap (root).
#
# - needrestart must not bounce playon units after unattended-upgrades
# - linger so systemd-run --user can create playon-server-*.scope

playon_install_needrestart_override() {
  local dest="/etc/needrestart/conf.d/playon.conf"
  mkdir -p /etc/needrestart/conf.d
  if [[ -n "${PLAYON_NEEDRESTART_SRC:-}" && -f "${PLAYON_NEEDRESTART_SRC}" ]]; then
    cp "${PLAYON_NEEDRESTART_SRC}" "${dest}"
  else
    cat >"${dest}" <<'EOF'
# PlayOn — do not auto-restart Home or node-agent after library upgrades (#1038).
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

playon_apply_host_hygiene() {
  local user="${1:-playon}"
  playon_install_needrestart_override
  playon_enable_user_linger "${user}"
}
