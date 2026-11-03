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
sudo cp infra/control-plane/linux/playon-server@.service /etc/systemd/system/playon-server@.service
sudo mkdir -p /etc/systemd/user /etc/needrestart/conf.d
sudo cp infra/control-plane/linux/playon.slice /etc/systemd/user/playon.slice
sudo install -d -o playon -g playon /home/playon/.config/systemd/user
sudo cp infra/control-plane/linux/playon.slice /home/playon/.config/systemd/user/playon.slice
sudo chown playon:playon /home/playon/.config/systemd/user/playon.slice
sudo cp infra/control-plane/linux/needrestart-playon.conf /etc/needrestart/conf.d/playon.conf
sudo loginctl enable-linger playon
sudo systemctl daemon-reload
# Do not restart until this prints KillMode=process. daemon-reload does not stop playon.
systemctl show playon.service -p KillMode
sudo systemctl enable --now playon playon-node
sudo systemctl status playon playon-node
```

`KillMode=process` on Home, plus a transient user service `playon-server-<name>.service` (optional `playon.slice`), keeps native games alive across a Home restart. A user scope cannot move PIDs that already live in `system.slice/playon.service`. Older `KillMode=mixed` units must be recopied and `daemon-reload`ed before the next restart — restarting the mixed unit SIGKILLs every native in that cgroup. needrestart is overridden so `apt`/unattended-upgrades do not bounce `playon*` (#1038 / #1045). Home relaunches every `desiredState=running` server on boot, including soak and NZL/Hub, and refuses a start that would reuse another server's launch name, home, or live port (#1016).

Open `http://playon.local` (or `http://<PLAYON_ADVERTISE_HOST>:8787` if mDNS/:80 failed). Owner bootstrap on first run. Optional: **Settings → Panel URL** for `https://<handle>.playon.games`.

`PLAYON_NODE_TOKEN` must be set before **Settings → Nodes → Add via SSH** (or the bootstrap one-liner). Home’s `deploy/install.sh` generates this automatically; the checkout path does not.

Without `playon-node`, the dashboard still shows a Local row, but it stays **offline** (no heartbeats / job execution).

## Panel HTTPS (Discord)

Link Discord from Home Settings to claim `https://<handle>.playon.games` (DNS A → LAN IP, Let’s Encrypt via playon.games). Not remote access. Advanced: you can still put Caddy/nginx in front of `127.0.0.1:8787` if you prefer.
