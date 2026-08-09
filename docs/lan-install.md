# LAN install (single-host production)

> **Preferred path:** [deploy.md](deploy.md) — Home tarball + `deploy/install.sh` (control plane + local node, Docker optional).
> This page remains the **checkout / systemd** path for developers and air-gapped clones.

Run PlayOn on a machine that can publish game ports to the LAN. Production is **one process**: the API serves the built web UI (prefer port **80** / `http://playon.local`, fall back to `PLAYON_PORT` default `8787`). Pair with `playon-node` (local node-agent) when using remote job routing. Optional: link Discord under **Settings → Panel URL** for `https://<handle>.playon.games` (LAN-only DNS; not remote access).

## Quick path (Linux host recommended)

1. Install Node 22, pnpm 9, Docker Engine — see [linux-dev-host.md](linux-dev-host.md).
2. Clone or sync the repo (preserve `apps/api/data` across syncs).
3. Install, build, and verify:

```bash
pnpm install
pnpm build
pnpm loop:verify   # on the lab host with Docker + Venice key
```

4. Create `/etc/playon/playon.env` (see [`infra/control-plane/linux/playon.env.example`](../infra/control-plane/linux/playon.env.example)):

```bash
PLAYON_ENV=production
PLAYON_HOST=0.0.0.0
PLAYON_PORT=8787
PLAYON_ADVERTISE_HOST=<your-lan-ip>
PLAYON_SESSION_SECRET=<long-random-string>
PLAYON_DATA_ROOT=/home/playon/src/playon/apps/api/data
PLAYON_RUNTIME=docker
PLAYON_LLM_MODE=openai_compatible
# Required to add LAN/cloud nodes (SSH / one-liner). Same value on each node-agent.
PLAYON_NODE_TOKEN=$(openssl rand -hex 24)
# PLAYON_VENICE_API_KEY=…   # or save key in Settings → Model after first login
```

5. Install systemd (paths in the units assume `/home/playon/src/playon` — edit if needed). Enable **both** the control plane and the local node-agent:

```bash
sudo cp infra/control-plane/linux/playon.service /etc/systemd/system/playon.service
sudo cp infra/control-plane/linux/playon-node.service /etc/systemd/system/playon-node.service
sudo systemctl daemon-reload
sudo systemctl enable --now playon playon-node
sudo systemctl status playon playon-node
```

Or run without systemd (foreground — API + local agent):

```bash
set -a && source /etc/playon/playon.env && set +a
pnpm start &
PLAYON_API_URL=http://127.0.0.1:8787 PLAYON_NODE_ID=local pnpm --filter @playon/node-agent start
```

6. Open `http://playon.local` (or `http://<your-lan-ip>:8787` if mDNS/:80 failed) for admin; players use `/play`. Local should show **online** within ~15s.
7. Create Owner on first run, save Venice API key under Settings → Model, then install Paper from the Map chat.
8. Optional: **Settings → Panel URL → Link Discord hostname** for `https://<handle>.playon.games` alongside `playon.local`.

Production refuses to start without `PLAYON_SESSION_SECRET` and `PLAYON_ADVERTISE_HOST` when `PLAYON_ENV=production` (or `NODE_ENV=production`).

## Panel URLs

- Everyone on the LAN: `http://playon.local` (mDNS) and/or `http://<lan-ip>` / `:8787`.
- After Discord link: also `https://<handle>.playon.games` (public DNS A → your LAN IP; traffic never leaves the LAN).
- Game join cards still use `PLAYON_ADVERTISE_HOST` (LAN IP).

## Optional reverse-proxy TLS

You can still terminate HTTPS with Caddy or nginx in front of PlayOn. Prefer the built-in Discord hostname path for Home optics. If you use your own proxy, point it at `127.0.0.1:8787` (loopback) or the LAN bind, and keep `PLAYON_ADVERTISE_HOST` as the LAN IP for game joins.

## Reboot recovery

After a host reboot:

```bash
sudo systemctl status playon playon-node
sudo systemctl status docker
docker ps   # game containers may need a Start from the Map if they exited
```

- **Data:** `PLAYON_DATA_ROOT` (default under `apps/api/data`) — DB, server dirs, snapshots.
- **Restore a world:** Map/chat → snapshot restore (confirm-gated), or restore from `PLAYON_BACKUP_ROOT` if configured.
- **Logs:** `journalctl -u playon -u playon-node -e` (look for JSON `playon_start` / `[node-agent] heartbeat ok`).

## Developer path (optional)

Split Vite + API for hot reload:

```bash
export PLAYON_HOST=0.0.0.0
export PLAYON_WEB_HOST=0.0.0.0
export PLAYON_ADVERTISE_HOST=<your-lan-ip>
pnpm dev
```

Open `http://<lan-ip>:5173` (proxies `/api` to `:8787`).

## Blank remote nodes

To add a spare Linux or Windows machine that heartbeats into the control plane, use **Settings → Nodes** (SSH or one-liner) or [`infra/blank-node/`](../infra/blank-node/README.md). `PLAYON_NODE_TOKEN` must already be set on the API host; the same value is installed on the new node.

## Packaging

Prefer the one-liner (`curl -fsSL https://playon.games/install | bash` / `irm https://playon.games/install.ps1 | iex`) or a portable Home archive — see [deploy.md](deploy.md).

Source zip fallback:

```bash
pnpm package:mvp
```

Unpack on the host, follow the included `INSTALL.md` (`pnpm install && pnpm build && pnpm start` or systemd).

## Success smoke

- Admin UI loads from `:8787` without Vite
- Paper starts on Docker; player panel shows `address:port` matching `PLAYON_ADVERTISE_HOST`
- A Minecraft client on the LAN can join
- `systemctl restart playon` (or reboot) brings the control plane back
