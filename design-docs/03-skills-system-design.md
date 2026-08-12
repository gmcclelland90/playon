# 03 – Game & Platform Package Design

## Purpose

**Game** and **Platform packages** are the encoded knowledge and capabilities that let agents manage specific games and common hosting tasks reliably. Player-facing catalog entries are **Games** (`games.*`); shared host capabilities are **Platform packages** (`platform.*`).

## Two Tiers

### Platform Packages
Shared across the installation:
- General server lifecycle management
- Container patterns and best practices
- Common modding workflows
- Monitoring, networking, RCON helpers
- Backup/snapshot orchestration helpers
- Cross-game utilities

### Game Packages
Live inside the individual server folder (or a dedicated package directory):
- Exact install & update procedures for that game
- Preferred runtime (Docker image, compose file, systemd unit, etc.)
- Config templates and validation rules
- Mod installation conventions and dependency handling
- Health checks and known failure modes
- RCON / admin command reference
- Templates for player-facing content

## Package Structure (Draft)

A Game or Platform package is a directory containing:

1. **metadata.yaml** (or .json)  
   - name, version, game, supported versions, os/arch requirements  
   - container support level (full / partial / none)  
   - required tools, ports, dependencies  
   - description and tags

2. **guides/**  
   Markdown (or similar) documents that agents read for reasoning:  
   - INSTALL.md, MODDING.md, TROUBLESHOOTING.md, PLAYER_SETUP.md, etc.

3. **scripts/**  
   Deterministic executable helpers (bash, Python, PowerShell…) that agents can invoke.

4. **templates/**  
   Config file templates, Dockerfiles, compose files, systemd units, etc.

5. **tests/** (optional but recommended)  
   Simple validation steps the agent can run after making changes.

6. **tools.md** or equivalent  
   Declares which tools this package expects the agent to have available.

## Lifecycle

- Install / update package (global or per-server)
- Override global Platform package behaviour at server level
- Promote a well-tested per-server Game to global
- Versioning and basic dependency declaration between packages

## Auto-Drafting Policy

Agents *can* research and draft new Game packages when a title is missing.  
This capability should **not** be overly aggressive:

- Prefer explicit user trigger (“research and draft a package for Game X”)
- Drafts are clearly marked and require human review before becoming permanent
- Drafts can be used immediately in a temporary capacity with clear warnings

## Design Goals

- Readable by both humans and agents
- Mix of declarative metadata + procedural knowledge + executable scripts
- Easy to version, share, and improve over time
- Encourage community contribution later
