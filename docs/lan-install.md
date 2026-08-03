# LAN install (single-host production)

> **Preferred path:** [deploy.md](deploy.md) — Home tarball + `deploy/install.sh` (control plane + local node, Docker optional).
> This page remains the **checkout / systemd** path for developers and air-gapped clones.

Run PlayOn on a machine that can publish game ports to the LAN. Production is **one process**: the API serves the built web UI on `PLAYON_PORT` (default `8787`). Pair with `playon-node` (local node-agent) when using remote job routing.

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
# PLAYON_VENICE_API_KEY=…   # or save key in Settings → Model after first login
```

5. Install systemd (paths in the unit assume `/home/playon/src/playon` — edit if needed):

```bash
sudo cp infra/control-plane/linux/playon.service /etc/systemd/system/playon.service
sudo systemctl daemon-reload
sudo systemctl enable --now playon
sudo systemctl status playon
```

Or run without systemd (foreground):

```bash
set -a && source /etc/playon/playon.env && set +a
pnpm start
```

6. Open `http://<your-lan-ip>:8787` for admin; players use `/play`.
7. Create Owner on first run, save Venice API key under Settings → Model, then install Paper from the Map chat.

Production refuses to start without `PLAYON_SESSION_SECRET` and `PLAYON_ADVERTISE_HOST` when `PLAYON_ENV=production` (or `NODE_ENV=production`).

## Optional TLS

Terminate HTTPS with Caddy or nginx in front of PlayOn (app stays HTTP). Point the proxy at `127.0.0.1:8787` if you bind only locally, or keep `PLAYON_HOST=0.0.0.0` on a trusted LAN. If the browser origin is an HTTPS hostname, add it to `PLAYON_CORS_ORIGINS` and set `PLAYON_ADVERTISE_HOST` to the name players should see for game joins (often still the LAN IP).

## Reboot recovery

After a host reboot:

```bash
sudo systemctl status playon
sudo systemctl status docker
docker ps   # game containers may need a Start from the Map if they exited
```

- **Data:** `PLAYON_DATA_ROOT` (default under `apps/api/data`) — DB, server dirs, snapshots.
- **Restore a world:** Map/chat → snapshot restore (confirm-gated), or restore from `PLAYON_BACKUP_ROOT` if configured.
- **Logs:** `journalctl -u playon -e` (look for JSON `playon_start` / errors).

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

To add a spare Linux or Windows machine that heartbeats into the control plane, use [`infra/blank-node/`](../infra/blank-node/README.md). Set the same `PLAYON_NODE_TOKEN` on the API host and the new node.

## Packaging zip

```bash
pnpm package:mvp
```

Unpack on the host, follow the included `INSTALL.md` (`pnpm install && pnpm build && pnpm start` or systemd).

## Success smoke

- Admin UI loads from `:8787` without Vite
- Paper starts on Docker; player panel shows `address:port` matching `PLAYON_ADVERTISE_HOST`
- A Minecraft client on the LAN can join
- `systemctl restart playon` (or reboot) brings the control plane back
