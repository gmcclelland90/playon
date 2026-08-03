# 04 – Agent System Design

## Purpose

PlayOn has **one agent** that performs work on behalf of the host.  
It loads game skills, reasons, calls tools, and keeps both the servers and the player-facing panel in good shape.

## One agent, many workflows

The agent is a generalist with the full tool surface. It handles install, config, mods, monitoring, backups, troubleshooting, and player-panel updates in one conversation — no separate “little guys” routing the chat.

Workflow flavor (for prompts and progression, not separate actors):

- **Install** – create and start servers from game skills
- **Mod** – add, update, remove, and validate mods
- **Config** – settings, ports, passwords, player limits, live rules
- **Monitor** – health, query, remediations
- **Panel** – publish join info and player-facing blocks
- **Fix** – diagnose and repair failures
- **Backup** – snapshots and restores
- **Lead** – general orchestration and routing within a turn

## Tooling Available to the Agent

Tools are strictly scoped:

- Filesystem access limited to the target server directory (+ global skills store)
- Container CLI (docker/podman)
- Process and service control (within allowed boundaries)
- RCON / game-specific admin protocols
- Network checks and port management helpers
- Web fetch (for downloading mods, reading docs, etc.)
- Snapshot / backup triggers
- Player-panel content publishing APIs

Each tool is tagged with a primary **agent skill** used only for XP / celebrations (see below). That tag does not gate which tools the agent may call.

## Conversation & Memory Model

- Primary interface is multi-turn chat with the host
- The agent maintains relevant context (current server, recent actions, skill versions)
- Important decisions and state changes are logged and attributed to the user

## Gamification (agent skills)

Progression is for fun on the map — not host trophies:

- Successful tools award XP to the tool’s tagged **agent skill** (Install, Monitor, Config, Fix, Backup, Panel, Mod, Lead)
- Skills level independently with evolving titles (Rookie → Legend)
- Celebrations and map accent color follow the active skill
- There is a single agent character on the canvas; the dock shows skill bars

**Naming:** *game skills* are install packages under `skills/`. *Agent skills* are the eight XP tracks above. Do not conflate them in product copy.

## Safety & Control

- All tool calls are subject to the security model (see Security document)
- Destructive or high-impact actions should prefer confirmation or automatic pre-snapshots
- The agent must surface uncertainty rather than guessing on critical operations

## Player Panel Integration

One of the agent’s first-class responsibilities is keeping the player-facing panel accurate and helpful.  
Content is pushed; the panel does not pull privileged information on its own.
