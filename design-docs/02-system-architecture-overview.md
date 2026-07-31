# 02 – System Architecture Overview

## High-Level Components

- **Web Panel (Admin + Player surfaces)**  
  Single self-hosted application serving both the admin interface and the player-facing panel.

- **Agent Runtime**  
  Orchestrates specialised agents, manages conversation state, tool calling, and skill loading.

- **Skills Store**  
  Global skills library + per-server skill overrides. Versioned packages.

- **Node Layer**  
  One or more machines (nodes) that actually run the game servers.  
  Nodes can be Linux or Windows. “Blank” nodes can be provisioned via IaC.

- **Per-Server Isolation**  
  Every managed server lives in its own directory containing game files, configs, mods, logs, and server-specific skills.

- **LLM Backends**  
  Pluggable: cloud APIs or local runtimes (Ollama, etc.).

- **Backup & Snapshot Service**  
  Cross-cutting concern that protects server state before and after agent actions.

## Topology

- **Single-node mode**: Everything runs on one machine (ideal for smaller LANs).
- **Multi-node mode**: Control plane on one host, game workloads distributed across nodes on the LAN.
- Nodes are discovered and registered with the control plane.
- Agents decide (or are instructed) which node is suitable for a given game.

## Data Isolation Model

```
/servers/
  └── <server-id>/
        ├── game/          # actual server files
        ├── mods/
        ├── configs/
        ├── logs/
        ├── skills/        # server-specific skills
        ├── snapshots/
        └── metadata.json
```

Global skills live in a separate, version-controlled store.

## Communication Flow (Simplified)

1. Admin chats with agents in the web panel.
2. Agents load relevant skills (global + server-specific).
3. Agents call tools (filesystem scoped to server, container CLI, process control, RCON, etc.).
4. Tools execute on the appropriate node.
5. Results and status flow back; agents update the player-facing panel as needed.
6. Important state changes trigger automatic snapshots.

## Key Architectural Decisions

- **Container-first**: Docker/Podman preferred. Native execution supported when containers are impractical.
- **Agent-scoped tools**: Agents never get unconstrained root access.
- **Player panel is push-only**: Agents decide what players see; players do not directly control servers.
- **Stable foundation**: Backups and snapshots are not an afterthought.

## Future Extension Points

- Community skill registry
- Cross-LAN or WAN federation (later)
- Deeper “computer use” agents inside dedicated VMs for awkward proprietary launchers
