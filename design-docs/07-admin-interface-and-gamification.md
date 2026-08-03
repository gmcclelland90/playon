# 07 – Admin Interface & Agent Visual Layer

## Dual Interface

1. **Primary: Canvas + Conversational Agent**  
   A sparse 2.5D canvas (2D sprites on a pannable plane) shows servers that already exist. Chat is how servers appear and how they are maintained.

2. **Secondary: Dashboard**  
   Ops visibility — nodes, game skills, snapshots, backups. Not a second home for creating servers.

The canvas is where you *watch*; chat is where you *direct*.

## Chat-first provisioning

- Empty map → **Describe a server** opens unbound install chat (no silent `POST /api/servers`).
- The agent creates via tools (`servers_create_from_skill`, imports). The new crate appears on the map; the conversation binds to that server.
- **+ Add server** deselects the current crate and opens a fresh install chat.
- Selecting a crate opens **maintain-only** chat. Creating/importing siblings is hard-blocked while a workspace is bound.

## Agent progression (not host trophies)

One agent helps with every server. Fun progression is **host-global agent skills** (Install, Monitor, Config, Fix, Backup, Panel, Mod, Lead):

- Skills gain XP and levels from successful tools (tool → skill mapping)
- Titles evolve with level
- Celebrations and map accents reflect the active skill
- The Controls dock shows skill bars for the single agent
- There is **no** host XP / achievement / trophy cabinet

## Visual stage

- PixiJS stage: server crates + **one** agent sprite
- `agent.activity` events drive motion and skill accent (fetch, write, run, …)
- Confirm gates can pause the agent at a “wait” pose

## UX Tone

- Powerful and trustworthy
- Entertaining without becoming childish or obstructive
- Celebrates the agent’s competence on the map — video-game map energy, not a second ops dashboard

## Design Goal

Make the host look forward to opening PlayOn — a living LAN map, not a dread-inducing panel.
