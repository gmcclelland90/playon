# Blank-node IaC templates

> **Preferred:** Home bundle scripts [`deploy/install-node.sh`](../../deploy/install-node.sh) / [`deploy/windows/install-node.ps1`](../../deploy/windows/install-node.ps1) — full runtime jobs (process / Docker / SteamCMD). See [docs/deploy.md](../../docs/deploy.md).

Provision a spare Linux or Windows machine so it can join a PlayOn control plane as a **node-agent**.

These templates remain thin cloud-init / bootstrap alternatives: Docker + Node 22 + the monorepo `node-agent`, wired with `PLAYON_API_URL` and `PLAYON_NODE_TOKEN`.

## Prerequisites on the control plane

1. PlayOn API reachable on the LAN (`PLAYON_HOST=0.0.0.0`).
2. Shared token set on both sides:

```bash
export PLAYON_NODE_TOKEN=change-me-long-random
```

3. Note the API base URL, e.g. `http://192.168.1.10:8787`.

## Linux (cloud-init or bootstrap script)

| File | Use |
|------|-----|
| [`linux/cloud-init.yaml`](linux/cloud-init.yaml) | Paste into Proxmox / cloud / Multipass user-data |
| [`linux/bootstrap.sh`](linux/bootstrap.sh) | Run as root on an existing Ubuntu 22.04+ box |

Example Multipass:

```bash
multipass launch 22.04 --name playon-node --cloud-init linux/cloud-init.yaml
```

Or on an existing host:

```bash
sudo PLAYON_API_URL=http://192.168.1.10:8787 \
  PLAYON_NODE_TOKEN=change-me-long-random \
  PLAYON_NODE_ID=lab-west \
  bash linux/bootstrap.sh
```

## Windows

| File | Use |
|------|-----|
| [`windows/bootstrap.ps1`](windows/bootstrap.ps1) | Elevated PowerShell on Windows 10/11 or Server |

Installs Node 22 via `winget` when missing, enables optional Docker Desktop notes, clones/syncs the repo, and registers a Scheduled Task for the node-agent.

```powershell
$env:PLAYON_API_URL = "http://192.168.1.10:8787"
$env:PLAYON_NODE_TOKEN = "change-me-long-random"
$env:PLAYON_NODE_ID = "lab-win"
.\windows\bootstrap.ps1
```

## Verify

On the control plane Dashboard → Nodes (or Chat → Machines), the new node should show **online** within ~15s of the first heartbeat.

## Out of scope (for now)

- Terraform / cloud provider modules
- Automatic game-port firewall rules per skill
- Full Cloud tunnel gateway (see design-docs/14); node runtime jobs are implemented in `apps/node-agent`
