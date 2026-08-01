# LAN install (MVP)

Run PlayOn on a machine that can publish game ports to the LAN.

## Quick path (Linux host recommended)

1. Install Node 22, pnpm 9, Docker Engine — see [linux-dev-host.md](linux-dev-host.md).
2. Clone or sync the repo (preserve `apps/api/data` across syncs).
3. Install and verify:

```bash
pnpm install
pnpm loop:verify
```

4. Start for LAN:

```bash
export PLAYON_HOST=0.0.0.0
export PLAYON_WEB_HOST=0.0.0.0
export PLAYON_ADVERTISE_HOST=<your-lan-ip>
export PLAYON_RUNTIME=docker   # or mock
export PLAYON_LLM_MODE=mock    # or ollama / openai_compatible
pnpm dev
```

5. Open `http://<your-lan-ip>:5173` for admin; players use `/play`.
6. Create Owner on first run, then create/start a skill (Paper) from Servers or Chat.

## Blank remote nodes

To add a spare Linux or Windows machine that heartbeats into the control plane, use the templates under [`infra/blank-node/`](../infra/blank-node/README.md) (cloud-init, `bootstrap.sh`, or `bootstrap.ps1`). Set the same `PLAYON_NODE_TOKEN` on the API host and the new node.

## Packaging zip

```bash
pnpm package:mvp
```

Unpack on the host, follow the included notes, run `pnpm install && pnpm loop:verify` then `pnpm dev` with the env vars above.

## Success smoke

- Admin can start Paper (or mock) and see live logs
- Player panel shows `address:port` matching `PLAYON_ADVERTISE_HOST`
- A Minecraft client on the LAN can join when runtime is Docker Paper
