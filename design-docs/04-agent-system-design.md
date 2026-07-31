# 04 – Agent System Design

## Purpose

Agents are the intelligent actors that perform work on behalf of the host.  
They load skills, reason, call tools, and keep both the servers and the player-facing panel in good shape.

## Specialised Agent Roles (Examples)

- **Installer Agent** – create new servers from skills
- **Modder Agent** – add, update, remove, and validate mods
- **Configurer Agent** – manage settings, ports, passwords, player limits, etc.
- **Monitor / Health Agent** – watch processes, logs, resources; remediate common issues
- **Player Panel Agent** – push content and collect structured input from the player surface
- **Troubleshooter Agent** – diagnose and fix problems
- **Backup Agent** – coordinate snapshots and restores
- **Generalist / Orchestrator** – routes work and maintains conversation context

Multiple specialised agents can collaborate on a single request.

## Tooling Available to Agents

Tools are strictly scoped:

- Filesystem access limited to the target server directory (+ global skills store)
- Container CLI (docker/podman)
- Process and service control (within allowed boundaries)
- RCON / game-specific admin protocols
- Network checks and port management helpers
- Web fetch (for downloading mods, reading docs, etc.)
- Snapshot / backup triggers
- Player-panel content publishing APIs

## Conversation & Memory Model

- Primary interface is multi-turn chat with the host
- Agents maintain relevant context (current server, recent actions, skill versions)
- Important decisions and state changes are logged and attributed to the user

## Gamification of Agents

Agents themselves are gamified:

- Gain XP and levels from successful tasks
- Unlock titles, visual flair, and personality traits
- Different agents can have distinct “characters” themed around games or hosting archetypes
- Successes, recoveries, and clean mod installs can trigger celebrations or achievements in the UI

This makes the management experience itself entertaining.

## Safety & Control

- All tool calls are subject to the security model (see Security document)
- Destructive or high-impact actions should prefer confirmation or automatic pre-snapshots
- Agents must surface uncertainty rather than guessing on critical operations

## Player Panel Integration

One of the agent’s first-class responsibilities is keeping the player-facing panel accurate and helpful.  
Content is pushed; the panel does not pull privileged information on its own.
