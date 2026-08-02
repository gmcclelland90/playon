# 07 – Admin Interface & Agent Visual Layer

## Dual Interface

1. **Primary: Canvas + Conversational Agents**  
   A sparse 2.5D canvas (2D sprites on a pannable plane) shows servers that already exist. Chat is how servers appear and how they are maintained.

2. **Secondary: Dashboard**  
   Ops visibility — nodes, skills, snapshots, backups. Not a second home for creating servers.

The canvas is where you *watch*; chat is where you *direct*.

## Chat-first provisioning

- Empty map → **Describe a server** opens unbound install chat (no silent `POST /api/servers`).
- Agents create via tools (`servers_create_from_skill`, imports). The new crate appears on the map; the conversation binds to that server.
- **+ Add server** deselects the current crate and opens a fresh install chat.
- Selecting a crate opens **maintain-only** chat. Creating/importing siblings is hard-blocked while a workspace is bound.

## Agent progression (not host trophies)

Agents are named personas **per server** (installer, monitor, configurer, …).

- Agents gain XP and levels from successful tools on that server
- Titles evolve with level
- Celebrations are scoped to the server’s cast
- There is **no** host XP / achievement / trophy cabinet

## Visual stage

- PixiJS stage: server crates + agent sprites
- `agent.activity` events drive motion (fetch, write, run, …)
- Confirm gates can pause an agent at a “wait” pose

## UX Tone

- Powerful and trustworthy
- Entertaining without becoming childish or obstructive
- Celebrates the agents’ competence on the map

## Design Goal

Make the host look forward to opening PlayOn — a living LAN map, not a dread-inducing panel.
