# 06 – Player-Facing Panel Design

## Purpose

A clean, always-relevant surface for players that removes friction from joining and understanding the games being hosted.

The panel is **fully agent-pushed**. Players do not directly control servers; they consume information and provide structured input that agents can act on.

## Core Design Principles

- Low cognitive load
- Immediately useful
- Game-flavoured but not cluttered
- Works well on phones and laptops (LAN party reality)
- Content stays synchronised with actual server state via agents

## Standard Content Blocks Agents Can Emit

Agents can publish structured or free-form blocks, including:

- **Server Status** – online/offline, player count, current map/mode, uptime
- **Join Information** – connection strings, Steam join links, IP + port, passwords (when appropriate)
- **Required Client Setup** – mods, patches, launchers, specific game versions, download links
- **Guides & Instructions** – step-by-step player setup, common gotchas
- **Voting / Preferences** – map votes, game choice, rules suggestions
- **Readiness Checks** – “I’m ready”, character select confirmations, etc.
- **Announcements** – messages from the host or agents
- **File Drops** – direct download of needed client files when useful
- **Discovery** – “What should we play next?” suggestions based on available skills/servers

## Interaction Model

- Primarily read-only consumption + lightweight structured input
- No direct server administration from the player side
- Agents decide when and what to show; they can also clear or update content reactively

## Visual & UX Goals

- Fast to scan
- Distinct sections that agents can target
- Support for both “one big current game” focus and multi-server overviews
- Optional theming that can lean into the currently active games

## Relationship to Agents

The Player Panel Agent (or any agent) treats the panel as a first-class output channel.  
Keeping players informed and unblocked is considered a core success criterion for the system.
