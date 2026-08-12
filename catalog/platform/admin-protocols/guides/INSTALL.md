# Admin protocols

Skills declare `adminDialect`. Prefer that over guessing.

| Dialect | Typical games | PlayOn today |
|---------|---------------|--------------|
| `mc_rcon` | Paper / Java Minecraft | `rcon_exec` / `rcon_say` |
| `source_rcon` | Many Steam/Source titles | Partial overlap; verify per game |
| `rust_web_rcon` | Rust (`+rcon.web 1`) | Ports/password in launch; dedicated client TBD |
| `http_rest` | Palworld (RCON deprecated), some modern titles | Use careful HTTP to LAN-only admin ports |
| `stdin` | Factorio wrappers, older consoles | Log follow + documented console commands |
| `none` | No remote admin | In-game op / host console only |

## Rules

1. Enable admin listeners on **LAN/bind** addresses; do not advertise admin ports on the player panel.
2. Palworld: prefer REST over RCON when both exist (RCON is deprecated upstream).
3. If RCON fails, check password file, port mismatch, and whether the process finished booting — then escalate.
4. Never print full RCON passwords in chat or panel blocks.
