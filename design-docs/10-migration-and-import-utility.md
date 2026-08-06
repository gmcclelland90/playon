# 10 – Migration & Import Utility

## Purpose

Remove the biggest adoption friction: people already have servers.  
They should be able to bring those servers under PlayOn management with minimal pain.

## Core Flow

1. Host points the agent at an existing source (FTP/SFTP, local path, rsync target, etc.).
2. System performs a carbon-copy import into a new (or specified) server folder.
3. Game type is detected where possible.
4. An initial server-specific skill is scaffolded (or an existing matching skill is attached).
5. Baseline snapshot is taken.
6. Agent verifies the imported server can be started and managed.
7. Host is given a clear report of what was imported and any manual follow-up needed.

## Capabilities

- Support for common transfer methods
- Handling of both stopped and (carefully) running servers
- Preservation of worlds, configs, and mods
- Generation of initial metadata and skill stubs
- Post-import health check and agent takeover

## Design Goals

- Make the import feel like a first-class, reliable feature rather than a hacky script
- Reduce the “I already have this working, I don’t want to start over” objection
- Produce a clean, manageable server at the end of the process

## Map Scan → Manage (shipped)

On a remote node pad, **Scan** finds allowlisted installs; **Manage** copies the install into the node’s PlayOn jail (no Home haul), then **cutover**:

1. Sniff systemd units whose `WorkingDirectory` / `ExecStart` reference the install.
2. Parse launch identity (`-servername`, `-world`, `+server.identity`, `--start-server`, …).
3. Copy hint-defined external userdata (e.g. `~/Zomboid`, Valheim/Terraria XDG paths) into `servers/<id>/home`.
4. Write `start.sh` + `.playon-start.env` (`PLAYON_HOME`, optional admin password).

Does **not** stop the old host unit — host must cut over with downtime. Fingerprint + cutover rules: `skills/import-hints.yaml`.

## Future Enhancements

- Incremental / sync-style imports
- Import from other popular game hosting panels
- Bulk import of multiple servers
