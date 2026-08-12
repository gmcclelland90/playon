# Docker basics (PlayOn)

- Prefer Docker/Podman when a skill declares `containerSupport: full`.
- Bind only the ports the game needs; prefer LAN-facing binds.
- Persist world/config via the server `dataPath` mounts.
- If the Docker daemon is missing on a Linux node, use **Settings → Nodes → Install Docker** (SSH or one-liner), or see [Docker on nodes](https://playon.games/docs/docker).
- Without Docker, container skills cannot start; native / SteamCMD skills are unaffected.
