#!/usr/bin/env bash
# Ensure Docker Engine is installed and running (Linux).
# Source from install.sh / install-node.sh, or run standalone as root:
#   sudo bash deploy/lib/ensure-docker.sh
#   curl -fsSL https://playon.games/ensure-docker | sudo bash
#
# Env:
#   PLAYON_INSTALL_DOCKER  Set to 0/false/off/no to skip (default: install when missing)
#   PLAYON_USER            Service user to add to the docker group (default: playon)
#
# Sets PLAYON_ENSURE_DOCKER_RESULT to: present | installed | skipped | failed

playon_ensure_docker() {
  PLAYON_ENSURE_DOCKER_RESULT="skipped"
  local user="${PLAYON_USER:-playon}"
  local flag="${PLAYON_INSTALL_DOCKER:-1}"
  case "$(echo "${flag}" | tr '[:upper:]' '[:lower:]')" in
    0|false|off|no) PLAYON_ENSURE_DOCKER_RESULT="skipped"; return 0 ;;
  esac

  if [[ -S /var/run/docker.sock ]]; then
    PLAYON_ENSURE_DOCKER_RESULT="present"
    if getent group docker >/dev/null 2>&1 && id -u "${user}" >/dev/null 2>&1; then
      usermod -aG docker "${user}" || true
    fi
    return 0
  fi

  if [[ "$(id -u)" -ne 0 ]]; then
    echo "playon_ensure_docker: root required to install Docker Engine" >&2
    PLAYON_ENSURE_DOCKER_RESULT="failed"
    return 1
  fi

  echo "==> Installing Docker Engine"
  export DEBIAN_FRONTEND=noninteractive
  if command -v curl >/dev/null 2>&1; then
    if ! curl -fsSL https://get.docker.com | sh; then
      echo "get.docker.com failed — trying distro packages" >&2
      if command -v apt-get >/dev/null 2>&1; then
        apt-get update -y
        apt-get install -y docker.io docker-compose-v2 || apt-get install -y docker.io
      elif command -v dnf >/dev/null 2>&1; then
        dnf install -y docker
      elif command -v yum >/dev/null 2>&1; then
        yum install -y docker
      else
        echo "playon_ensure_docker: no supported package manager" >&2
        PLAYON_ENSURE_DOCKER_RESULT="failed"
        return 1
      fi
    fi
  elif command -v apt-get >/dev/null 2>&1; then
    apt-get update -y
    apt-get install -y docker.io
  else
    echo "playon_ensure_docker: need curl or apt-get" >&2
    PLAYON_ENSURE_DOCKER_RESULT="failed"
    return 1
  fi

  if command -v systemctl >/dev/null 2>&1; then
    systemctl enable --now docker 2>/dev/null || systemctl enable --now docker.service 2>/dev/null || true
  elif command -v service >/dev/null 2>&1; then
    service docker start || true
  fi

  if getent group docker >/dev/null 2>&1 && id -u "${user}" >/dev/null 2>&1; then
    usermod -aG docker "${user}" || true
  fi

  if [[ ! -S /var/run/docker.sock ]]; then
    echo "playon_ensure_docker: Docker installed but socket missing" >&2
    PLAYON_ENSURE_DOCKER_RESULT="failed"
    return 1
  fi

  PLAYON_ENSURE_DOCKER_RESULT="installed"
  echo "==> Docker Engine ready"
  return 0
}

playon_flip_runtime_docker() {
  local f="$1"
  [[ -f "$f" ]] || return 0
  if grep -q '^PLAYON_RUNTIME=' "$f" 2>/dev/null; then
    sed -i 's/^PLAYON_RUNTIME=.*/PLAYON_RUNTIME=docker/' "$f" || true
  else
    echo "PLAYON_RUNTIME=docker" >>"$f"
  fi
}

playon_ensure_docker_main() {
  playon_ensure_docker
  playon_flip_runtime_docker /etc/playon/playon.env
  playon_flip_runtime_docker /etc/playon/node.env
  if command -v systemctl >/dev/null 2>&1; then
    systemctl restart playon-node.service 2>/dev/null || true
    systemctl restart playon-node-agent.service 2>/dev/null || true
  fi
}

# Run when executed (including curl|bash); skip when sourced.
if (return 0 2>/dev/null); then
  :
else
  set -euo pipefail
  playon_ensure_docker_main
fi
