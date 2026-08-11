# WSL Linux Runtime (PlayOn)

Enable Linux game servers on Windows Home using Windows Subsystem for Linux 2 (WSL2).

## When to use

- Windows Home edition (no Hyper-V / Docker Desktop)
- A skill requires `os: linux` but only a Windows machine is available
- You want to run Linux-only game servers locally without a separate Linux box

## Requirements

- Windows 10 version 2004+ or Windows 11
- Virtualization enabled in BIOS/UEFI
- Administrator access for initial setup

## Agent tools

| Tool | Purpose |
|------|---------|
| `wsl_status` | Check current WSL installation state |
| `wsl_enable` | Install WSL2 + PlayOn distro + Docker + agent (requires confirmation) |
| `wsl_repair` | Fix broken installations (requires confirmation) |

## Setup flow

1. **Check status**: `wsl_status` returns one of:
   - `not_installed` — WSL not present
   - `reboot_required` — WSL installed, reboot needed
   - `distro_missing` — WSL present but PlayOn distro not set up
   - `docker_missing` — Distro present but Docker not installed
   - `agent_missing` — Docker present but node agent not running
   - `ready` — Fully operational
   - `error` — Check the `error` field for details

2. **Enable**: Run `wsl_enable` (requires host confirmation via UAC). This:
   - Installs WSL2 if missing
   - Creates the PlayOn Ubuntu distro
   - Installs Docker Engine inside the distro
   - Starts the node agent connecting back to the control plane

3. **Verify**: After enable completes, the `local-wsl` node appears in **Settings → Nodes** and becomes eligible for Linux skills.

## Common errors

| Error code | Meaning | Resolution |
|------------|---------|------------|
| `wsl_reboot_required` | WSL kernel installed, reboot pending | Reboot Windows, then retry |
| `wsl_virt_disabled` | Hardware virtualization off | Enable VT-x/AMD-V in BIOS |
| `wsl_user_cancelled_uac` | User declined elevation prompt | Re-run and approve the UAC dialog |
| `wsl_distro_failed` | Distro import failed | Run `wsl_repair` |
| `wsl_docker_failed` | Docker install failed inside distro | Run `wsl_repair` |
| `wsl_agent_failed` | Node agent failed to start | Run `wsl_repair` |

## Manual fallback

If automated setup fails repeatedly:

1. Open PowerShell as Administrator
2. Run: `wsl --install -d Ubuntu`
3. Reboot if prompted
4. Inside the new Ubuntu terminal, run the one-liner from **Settings → Nodes → Add Node**

## Networking notes

The WSL Linux runtime uses NAT networking by default. Servers bind to WSL's internal IP and are forwarded through Windows. For LAN play, Windows Firewall rules are created automatically. Phase 2 will add bridge/host networking options.

## Troubleshooting

- **Node shows offline**: Check that the WSL distro is running (`wsl -l -v` in PowerShell)
- **Docker errors**: Inside WSL, run `sudo systemctl status docker`
- **Port conflicts**: Ensure no Windows service is using the same port

## See also

- [Docker basics](../docker-basics/guides/INSTALL.md) — for Docker-specific guidance
- [Networking LAN](../networking-lan/guides/INSTALL.md) — for LAN discovery
