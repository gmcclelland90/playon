# 15 – playon.games site & skill library

## Status

**Separate workstream** from control-plane / skill-seeding in the monorepo.  
This document kicks off the public site + hosted skill library so product and eng can plan without blocking in-app skill packaging.

## Goals

playon.games should cover three jobs:

1. **Get PlayOn** — download / install paths (Linux party box, Docker, source)
2. **How to use** — short host + player docs, LAN party happy path
3. **Skill library** — browse / search / download official (and later community) `.skill.zip` packages

The control plane already speaks `.skill.zip` (export/import). The site hosts and discovers those artifacts; agents later call marketplace search/install against the same catalog.

## Non-goals (v1 site)

- Replacing the self-hosted admin UI
- Running game servers in the cloud for users
- Full account/billing platform
- Signing every package on day one (add when community submit opens)

## Catalog model

```text
https://playon.games/skills/index.json
https://playon.games/skills/packages/{name}-{version}.skill.zip
```

Suggested `index.json` entry shape:

```json
{
  "updatedAt": "2026-08-02T00:00:00Z",
  "skills": [
    {
      "name": "games.minecraft-paper",
      "version": "0.1.0",
      "game": "Minecraft (Paper)",
      "description": "…",
      "tags": ["minecraft", "paper", "docker"],
      "dependencies": ["platform.docker-basics", "platform.networking-lan"],
      "containerSupport": "full",
      "minRamMb": 2048,
      "downloadUrl": "https://playon.games/skills/packages/games.minecraft-paper-0.1.0.skill.zip",
      "sha256": "…",
      "official": true
    }
  ]
}
```

Package format = existing PlayOn skill zip (`metadata.yaml` at root + `guides/` …). No second format.

## Site IA (first ship)

| Route | Purpose |
|-------|---------|
| `/` | Brand + one CTA to Get PlayOn |
| `/get` | Install options |
| `/docs` (or `/guide`) | Host + player how-to |
| `/skills` | Library browse/search |
| `/skills/{name}` | Detail + download + dependency list |

Keep the first viewport brand-led (see frontend design rules). Library pages are the place for grids/filters.

## Phased delivery

### Phase A — static official library

- Static site (or minimal framework) on playon.games
- `index.json` + zips published from CI of this monorepo (`pnpm skills:export` → `dist/skills/`)
- Seeded catalog skills (as of seeding track): Paper, Rust, UT99, Valheim, Terraria, Factorio + platform packs
- No accounts

### Phase B — wire PlayOn agents

- `skill_search` / `skill_install_url` in the API against `PLAYON_SKILLS_CATALOG_URL` (default `https://playon.games/skills/index.json`)
- Agent install workflow: local → catalog → draft
- Settings UI: “Browse skill library”

### Phase C — community

- Submit flow (upload zip → quarantine → review)
- Publisher identity, versioning, yank/update policy
- Optional signing / checksum enforcement already hinted by `sha256` in the index

## Relationship to the monorepo

| In monorepo (now) | On playon.games (this track) |
|-------------------|------------------------------|
| Platform + game skill **content** | Hosting + discovery UI |
| `.skill.zip` export/import | CDN / static file hosting |
| Runtime that honors skill metadata | Docs for hosts/players |
| `PLAYON_SKILLS_PROFILE=minimal\|dev` | “Get PlayOn” install stories |

## Open product choices (for the site track)

1. SSG (Astro/Next static) vs small custom site
2. Whether docs live on the site only or also mirror into `docs/`
3. Domain DNS / hosting (Cloudflare Pages, etc.)
4. When to expose community submit

## Success metric

A fresh PlayOn install with `minimal` profile can install `games.minecraft-paper` from the library URL and reach a joinable LAN server without any game skill being bundled in the binary.
