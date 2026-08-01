# LAN networking

## Checklist

1. Prefer bind `0.0.0.0` for dedicated servers so other machines on the LAN can join.
2. Use `net_suggest_bind` when the preferred game port is taken.
3. Use `net_port_check` from the host after start to confirm the listener is up.
4. Publish `join_info` with the host's LAN IP (not `127.0.0.1`) for players on other PCs.
5. Open Windows Firewall / ufw for the game port when peers cannot connect.
