# Server auth & secrets

## Never on the player panel

- RCON / admin / SteamCMD account passwords
- GSLT / game server login tokens
- Factorio.com tokens, Hytale device codes, license keys
- Whitelist private notes that include real-world identity

Panel may say “password required” or “ask the host” — not the secret itself.

## Common mechanisms

| Mechanism | Where | Notes |
|-----------|-------|-------|
| Minecraft EULA | Java containers (`EULA=TRUE`) | Required before Paper starts |
| online-mode / LAN offline | Java | LAN parties often use offline mode; document trust boundaries |
| Whitelist / ops / bans | Most games | Prefer files in `game/` + snapshot before edits |
| Steam GSLT | Source-family | Needed for public listing; keep in host secrets |
| SteamCMD owned login | Some app updates | Prefer a dedicated throwaway Steam account; never log credentials |
| Hytale device auth | Hytale | Host-attended browser flow on first boot |
| Bedrock Microsoft auth | Bedrock | Separate from Java offline LAN tricks |

## Agent rules

1. Generate strong random admin/RCON passwords into server-local config (e.g. `rcon.json`), not chat.
2. Snapshot before rotating secrets.
3. If a skill’s first boot needs interactive auth, tell the host clearly and pause automation.
