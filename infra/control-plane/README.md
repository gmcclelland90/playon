# Control-plane install (single host)

> Prefer the Home package in [docs/deploy.md](../../docs/deploy.md) (`deploy/install.sh`).
> This folder remains the checkout-based systemd setup for lab/dev hosts.

Run the API + built web UI and the **local node-agent** as systemd services on a LAN host.

## One-time setup

```bash
cd /home/playon/src/playon   # or your clone path
pnpm install
pnpm build

sudo mkdir -p /etc/playon
sudo cp infra/control-plane/linux/playon.env.example /etc/playon/playon.env
sudo nano /etc/playon/playon.env   # set SESSION_SECRET, ADVERTISE_HOST, NODE_TOKEN
# Generate a node token if you left the placeholder:
#   openssl rand -hex 24
sudo chmod 640 /etc/playon/playon.env
sudo chown root:playon /etc/playon/playon.env

# Adjust WorkingDirectory / User in the units if your paths differ
sudo cp infra/control-plane/linux/playon.service /etc/systemd/system/playon.service
sudo cp infra/control-plane/linux/playon-node.service /etc/systemd/system/playon-node.service
sudo systemctl daemon-reload
sudo systemctl enable --now playon playon-node
sudo systemctl status playon playon-node
```

Open `http://playon.local` (or `http://<PLAYON_ADVERTISE_HOST>:8787` if mDNS/:80 failed). Owner bootstrap on first run. Optional: **Settings → Panel URL** for `https://<handle>.playon.games`.

`PLAYON_NODE_TOKEN` must be set before **Settings → Nodes → Add via SSH** (or the bootstrap one-liner). Home’s `deploy/install.sh` generates this automatically; the checkout path does not.

Without `playon-node`, the dashboard still shows a Local row, but it stays **offline** (no heartbeats / job execution).

## Panel HTTPS (Discord)

Link Discord from Home Settings to claim `https://<handle>.playon.games` (DNS A → LAN IP, Let’s Encrypt via playon.games). Not remote access. Advanced: you can still put Caddy/nginx in front of `127.0.0.1:8787` if you prefer.
