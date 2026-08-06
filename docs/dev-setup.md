# PlayOn developer setup

## Prerequisites

- Node.js 22 LTS or newer
- pnpm 9 (`npm install -g pnpm@9`)
- Optional: Docker Engine for real runtime smokes
- Optional: Ollama for offline LLM demos

## Devcontainer (recommended for agents)

Open the repo in a Dev Container (`.devcontainer/`). That gives Node 22, pnpm, and Docker-in-Docker with mock defaults. See [.devcontainer/README.md](../.devcontainer/README.md).

## Install & verify

```bash
pnpm install
pnpm verify            # fast bar
pnpm loop:verify       # merge bar (+ int + agent-replay)
```

`pnpm loop:verify` is the autonomous merge bar. It does **not** need Docker, Steam, or cloud API keys. See [agent-dev-loop.md](agent-dev-loop.md).

## Local run

```bash
pnpm dev
```

Or in separate terminals:

```bash
pnpm --filter @playon/api dev
pnpm --filter @playon/web dev
pnpm --filter @playon/node-agent dev
```

For remote agents (and Settings → Nodes add via SSH / one-liner), set the same `PLAYON_NODE_TOKEN` on the API host and each node-agent. Heartbeats send `Authorization: Bearer …`. Without a token the API stays open for local single-host use, but adding nodes fails with `node_token_unset`. Dashboard marks nodes `online` / `stale` / `offline` from `lastSeenAt` — run the local node-agent (`playon-node`) so Local stays online.

Blank-machine imaging: [`infra/blank-node/README.md`](../infra/blank-node/README.md).

## Import / Manage existing servers

- **Map Scan → Manage (preferred on a remote node):** Dashboard map → click an online host pad → Scan. PlayOn fingerprints allowlisted install roots (`skills/import-scan-roots.yaml` + `skills/import-hints.yaml`), then **Manage** seeds the install on that node (no LAN haul to Home), runs **cutover** (systemd launch args + external userdata into `servers/<id>/home`), and writes `game/start.sh`. Stop the old host service before Start in PlayOn.
- **Local path:** Servers → Import, or `POST /api/servers/import` with an absolute `sourcePath`.
- **SFTP:** same UI (SFTP mode) or `POST /api/servers/import/sftp` with host/username/password (or private key via the agent tool) and `remotePath`. Files stage under `data/imports/` then run the local import pipeline (skill attach/draft + baseline snapshot).

Cutover metadata lives on each fingerprint’s optional `manage:` block in `skills/import-hints.yaml` (userdata home dirs, `serverNameArg`, `adminPasswordArg`, `worldSubdirs`).

## Test layers

| Command | Purpose |
|---------|---------|
| `pnpm check` | Typecheck |
| `pnpm test:unit` | Unit tests |
| `pnpm test:contract` | Schema/protocol contracts |
| `pnpm --filter @playon/api test:int` | API + SQLite integration |
| `pnpm --filter @playon/agent-core test:agent` | Agent replay (when present) |
| `pnpm test:e2e` | Playwright UI smoke (opt-in; run `pnpm test:e2e:install` once) |

LAN / MVP exit: [lan-install.md](lan-install.md), [mvp-exit-checklist.md](mvp-exit-checklist.md), [ollama-offline.md](ollama-offline.md).

## Scheduled snapshots

Set `PLAYON_SNAPSHOT_INTERVAL_MS` (e.g. `3600000` for hourly) to enable automatic snapshots of **running** servers. Retention defaults: keep 10 quick/scheduled snapshots per server, drop those older than 72h. Labels starting with `baseline` / `backup` are never auto-pruned.

## Off-node backups

Set `PLAYON_BACKUP_ROOT` (or configure the path under Settings → Off-node backups) to an absolute path on a USB drive, NAS mount, or second disk. Dashboard **Off-node** copies a durable snapshot there; restore pulls it back into the local snapshot store and rolls the server forward.
