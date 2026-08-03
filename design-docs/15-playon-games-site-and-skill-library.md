# 15 – playon.games site & skill library

## Status

**Shipped as a sibling repo** (`playon-games` — Astro + Cloudflare Pages/Workers).  
Home / control-plane never bundles `games.*`; hosts install from the playon.games catalog.

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

### Phase A — official library (done in sibling repo)

- Astro site on playon.games (`playon-games` repo)
- Author trees only in sibling `skills-src/`; publish via `pnpm catalog` → `public/skills/`
- Seeded catalog skills: Paper, Rust, UT99, Valheim, Terraria, Factorio
- Monorepo has no `games.*`; Home remains platform-only (`PLAYON_SKILLS_PROFILE=minimal`)

### Phase B — wire PlayOn agents

- `skill_search` / `skill_install_url` in the API against `PLAYON_SKILLS_CATALOG_URL` (default `https://playon.games/skills/index.json`)
- Agent install workflow: local → catalog → draft
- Settings UI: “Browse skill library”

### Phase C — community

- Submit flow (upload zip → quarantine → review)
- Publisher identity, versioning, yank/update policy
- Optional signing / checksum enforcement already hinted by `sha256` in the index

## Relationship to the monorepo

| In monorepo | In sibling `playon-games` / playon.games |
|-------------|------------------------------------------|
| Platform skills (Home bundle) | Site UI + LAN hub |
| No curated `games.*` sources | `skills-src/` + `public/skills/` catalog |
| Runtime install into `dataRoot/skills` | Hosted `index.json` + `.skill.zip` |
| `.skill.zip` import/API | Cloudflare Pages/Workers deploy |

## Open product choices (for the site track)

1. Whether host/player docs live only on the site or also mirror into monorepo `docs/`
2. When to expose community submit
3. Signing / checksum policy beyond `sha256` in the index

## Success metric

A fresh PlayOn install with `minimal` profile can install `games.minecraft-paper` from the library URL and reach a joinable LAN server without any game skill being bundled in the binary.
