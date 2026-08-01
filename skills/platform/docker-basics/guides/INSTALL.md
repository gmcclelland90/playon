# Docker basics (PlayOn)

- Prefer Docker/Podman when a skill declares `containerSupport: full`.
- Bind only the ports the game needs; prefer LAN-facing binds.
- Persist world/config via the server `dataPath` mounts.
- If the Docker daemon is down, PlayOn falls back to mock runtime for testing — warn the host.
