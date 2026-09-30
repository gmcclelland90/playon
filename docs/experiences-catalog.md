# Experiences catalog (playon.games)

Shareable `experiences.*` packages sit **beside** the games catalog. Home can browse and install them onto an **existing** server. Curated listing lives in sibling **playon-games** (this monorepo does not host `experiences.*` zips).

## Contract (Home ↔ site)

| Piece | Default (reversible) |
|-------|----------------------|
| Index URL | `https://playon.games/packages/experiences/index.json` |
| Zip URL | `https://playon.games/packages/experiences/{slug}-{version}.experience.zip` |
| Site browse | `/experiences` (next to `/skills`) |
| Site detail | `/experiences/experiences.{id}` |
| Home deep link | `/skills?tab=experiences&name=experiences.{id}` |

Env override: `PLAYON_EXPERIENCES_CATALOG_URL`. Settings key: `experiences.catalog`.

### Index shape

```json
{
  "updatedAt": "2026-10-01T00:00:00Z",
  "experiences": [
    {
      "name": "experiences.demo-locker",
      "version": "0.1.0",
      "displayName": "Shared Locker Demo",
      "description": "…",
      "baseGame": "games.project-zomboid",
      "tags": ["zomboid", "mod"],
      "downloadUrl": "https://playon.games/packages/experiences/demo-locker-0.1.0.experience.zip",
      "sha256": "…",
      "official": true,
      "clientNeed": "none"
    }
  ]
}
```

Separate from `packages/index.json` (`skills[]`) so games stay unchanged.

### Install semantics

- Home tools: `experiences_search`, `experiences_install_url` (confirm + snapshot).
- HTTP: `GET /api/experiences/catalog`, `POST /api/experiences/install-from-catalog` (`serverId` + `name` or `downloadUrl`).
- Never creates a sibling server (`servers_create_from_skill` stays games-only).
- Missing index (`404`) → empty list, not a Home outage.

### playon-games follow-up (deferred when PAT/write unavailable)

1. Publish empty or seeded `public/packages/experiences/index.json`.
2. Add `/experiences` library page beside `/skills`.
3. Detail page CTA: **Open in Home** → `http://playon.local/skills?tab=experiences&name=…` (or host advertise URL).
4. Optional: mirror Install copy on game detail pages when `baseGame` matches.

Brand/placement default: tab label **Experiences**, site path `/experiences`. Change later without breaking deep links (`name=` query stays stable).

See [design-docs/15](../design-docs/15-playon-games-site-and-skill-library.md), [design-docs/20](../design-docs/20-ai-modding.md), [ai-modding-loop.md](ai-modding-loop.md).
