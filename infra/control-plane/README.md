# Control-plane install (single host)

Run the API + built web UI as one systemd service on a LAN host.

## One-time setup

```bash
cd /home/playon/src/playon   # or your clone path
pnpm install
pnpm build

sudo mkdir -p /etc/playon
sudo cp infra/control-plane/linux/playon.env.example /etc/playon/playon.env
sudo nano /etc/playon/playon.env   # set SESSION_SECRET + ADVERTISE_HOST
sudo chmod 600 /etc/playon/playon.env

# Adjust WorkingDirectory / User in the unit if your paths differ
sudo cp infra/control-plane/linux/playon.service /etc/systemd/system/playon.service
sudo systemctl daemon-reload
sudo systemctl enable --now playon
```

Open `http://<PLAYON_ADVERTISE_HOST>:8787` (Owner bootstrap on first run).

## Optional TLS

Terminate TLS with Caddy or nginx in front of `127.0.0.1:8787` (or the LAN bind). Keep PlayOn on HTTP; set `PLAYON_CORS_ORIGINS` / advertise host to the public HTTPS name if the browser origin differs.
