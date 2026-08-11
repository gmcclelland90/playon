# WSL Linux Runtime (PlayOn)

Enable Linux game servers on a **Windows node** using Windows Subsystem for Linux 2 (WSL2). Home may be on Linux or Windows — enabling WSL adds a **sibling** Linux agent on the same Windows machine.

## When to use

- A skill requires `os: linux` but only a Windows machine is available
- Lab topology: Linux Home + Windows node — enable WSL on that Windows node
- One-box Windows Home — enable WSL on `local` to get `local-wsl`

## Requirements

- Windows 10 version 2004+ or Windows 11
- Virtualization enabled in BIOS/UEFI
- Administrator access for initial setup (UAC or elevated one-liner)

## Agent tools

| Tool | Purpose |
|------|---------|
| `wsl_status` | Check WSL state for a Windows `nodeId` (default `local`) |
| `wsl_enable` | Install WSL2 + PlayOn distro + Docker + sibling agent (confirm); may return `oneLiner` |
| `wsl_repair` | Fix broken installations (confirm); may return `oneLiner` |

Pass `nodeId` for the Windows node. Sibling ids: `local` → `local-wsl`, otherwise `{nodeId}-wsl`.

## Setup flow

1. **Check status**: `wsl_status` with the Windows node id returns one of:
   - `not_installed` — WSL not present / not enrolled
   - `reboot_required` — WSL installed, reboot needed
   - `distro_missing` — WSL present but PlayOn distro not set up
   - `docker_missing` — Distro present but Docker not installed
   - `agent_missing` — Docker present but node agent not running / waiting
   - `ready` — Sibling node online (or local script reports ready)
   - `error` — Check the `error` field for details

2. **Enable**: Run `wsl_enable` (requires confirmation).
   - On Windows Home targeting `local`, UAC may run setup on that machine.
   - From Linux Home (or any remote Home), the tool returns an elevated PowerShell `oneLiner` — run it on the Windows host.
   - Setup installs WSL2, creates the PlayOn Ubuntu distro, installs Docker Engine, and starts the sibling node agent against Home.

3. **Verify**: The sibling (`local-wsl` or `{nodeId}-wsl`) appears in **Settings → Nodes** and becomes eligible for Linux skills.

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

```powershell
.\deploy\windows\ensure-wsl-runtime.ps1 `
  -ApiUrl 'http://HOME:8787' `
  -NodeToken '<PLAYON_NODE_TOKEN>' `
  -NodeId 'win-1-wsl'
```

Run elevated. Or use the one-liner from **Settings → Nodes → Enable Linux runtime**.

## Networking notes

The WSL Linux runtime uses NAT networking by default. Servers bind to WSL's internal IP and are forwarded through Windows. For LAN play, Windows Firewall rules are created automatically. Phase 2 will add bridge/host networking options.

## Troubleshooting

- **Node shows offline**: Check that the WSL distro is running (`wsl -l -v` in PowerShell)
- **Docker errors**: Inside WSL, run `sudo systemctl status docker`
- **Port conflicts**: Ensure no Windows service is using the same port
- **Wrong Home**: Confirm `-ApiUrl` / `-NodeToken` match the Home this Windows node already joins

## See also

- [Docker basics](../docker-basics/guides/INSTALL.md) — for Docker-specific guidance
- [Networking LAN](../networking-lan/guides/INSTALL.md) — for LAN discovery
