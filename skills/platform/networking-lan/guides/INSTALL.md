# LAN networking

## Checklist

1. Prefer bind `0.0.0.0` for dedicated servers so other machines on the LAN can join.
2. Use `net_suggest_bind` when the preferred game port is taken.
3. Use `net_port_check` from the host after start to confirm the listener is up.
4. **Required after every game start:** `panel_publish` with `join_info` using the host's LAN IP (not `127.0.0.1`) plus `client_setup` so phones/laptops on `/play` show how to join. The public panel hides blocks when the server is stopped.
5. Open Windows Firewall / ufw for the game port when peers cannot connect.
