# 05 – Runtime & Node Management

## Runtime Philosophy

**Container-first, flexible fallback.**

- Prefer Docker or Podman for isolation, reproducibility, and clean lifecycle management.
- Skills should provide (or generate) container definitions whenever feasible.
- Native execution (systemd units, Windows services, raw processes) is fully supported for games that do not containerise well.
- Hybrid approaches are allowed (e.g. container for the server process + native helper tools).

## Node Model

- A **Node** is a machine that can run game servers.
- Nodes may be Linux or Windows.
- The control plane discovers and registers nodes.
- Agents (or the host) select an appropriate node when creating or moving a server.

### Blank / Provisionable Nodes

Some nodes may start “blank”.  
Agents can use Infrastructure-as-Code templates to bring up a suitable Linux or Windows environment on demand.  
This supports dynamic capacity during larger LAN events.

## Responsibilities of the Runtime Layer

- Start / stop / restart servers cleanly
- Apply resource limits where possible
- Manage networking and port exposure (with host awareness of LAN vs external)
- Report health and basic metrics back to agents
- Support live log streaming
- Integrate with the snapshot system before major changes

## Health & Recovery

- Skills define expected health checks (process running, port listening, RCON responding, log patterns, etc.).
- Monitor agents can attempt automatic remediation for well-known failure modes.
- Persistent or novel failures are escalated to the host with context and logs.

## Design Goals

- Make the happy path (containerised games) extremely smooth
- Never block a game from being hosted just because it resists containerisation
- Keep node and runtime concerns largely invisible to the casual host while remaining powerful for advanced users
