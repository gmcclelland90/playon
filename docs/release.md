# Release & CI/CD pipeline

Standard path for shipping PlayOn Home and keeping [playon.games](https://playon.games) (installers + OTA manifest) in sync.

## Repos

| Repo | Role | Production trigger |
|------|------|--------------------|
| [`playon`](https://github.com/gmcclelland90/playon) | Control plane / Home + node packages | Push tag `v*` → `.github/workflows/release-home.yml` |
| [`playon-games`](https://github.com/gmcclelland90/playon-games) | Site, docs, skill catalog, `/home/latest.json` | Push `master` **or** `repository_dispatch` `playon-release` → `.github/workflows/deploy-pages.yml` |

Cloudflare Pages for `playon-games` is **Direct Upload** (Git Provider: No). Deploys go through GitHub Actions + `wrangler pages deploy`, not the Cloudflare Git integration.

## One-time secrets setup

### playon-games

1. Cloudflare → [API Tokens](https://dash.cloudflare.com/profile/api-tokens) → **Create Token**  
   - Use template **Edit Cloudflare Workers** (includes Pages), or custom with **Account → Cloudflare Pages → Edit** and **Account Settings → Read**.  
   - Account resources: include `Glenn@theitfactor.com.au's Account` (`7607248f01e41e739573dc4d39ccc3f6`).
2. GitHub → `playon-games` → Settings → Secrets and variables → Actions:
   - Secret `CLOUDFLARE_API_TOKEN` = that token  
   - Variable `CLOUDFLARE_ACCOUNT_ID` = `7607248f01e41e739573dc4d39ccc3f6`

```bash
# from a machine with gh + the new token in the clipboard / env
gh variable set CLOUDFLARE_ACCOUNT_ID --repo gmcclelland90/playon-games --body '7607248f01e41e739573dc4d39ccc3f6'
gh secret set CLOUDFLARE_API_TOKEN --repo gmcclelland90/playon-games
# paste token when prompted
```

### playon (cross-repo notify)

1. Create a **fine-grained PAT** (recommended) on `playon-games` with:
   - **Contents: Read and write** (not required for dispatch-only, but useful for manual sync)
   - Permission to create repository dispatches / **Administration: Read** is not enough — use a classic PAT with `repo` scope, or fine-grained with Contents + Metadata on `playon-games`
2. GitHub → `playon` → Secrets → Actions → `PLAYON_GAMES_TOKEN` = that PAT  
   Do **not** rely on a short-lived `gh auth token`; regenerate if Actions `notify-site` starts failing with 401/403.

```bash
gh secret set PLAYON_GAMES_TOKEN --repo gmcclelland90/playon
# paste PAT when prompted
```

Smoke test site deploy without a release:

```bash
gh workflow run deploy-pages.yml --repo gmcclelland90/playon-games
gh run watch --repo gmcclelland90/playon-games
curl -fsSL https://playon.games/home/latest.json | head
```

## Standard Home release (every version)

Do this on `main` after the **merge bar** is green on the lab (`pnpm loop:verify`; add `:runtime` when the release touches Docker lifecycle). Fast CI (`pnpm verify`) alone is not enough for a Home tag.

**Preflight**

- [ ] No open `P0` issues
- [ ] Open `P1` issues empty **or** explicitly deferred in the CHANGELOG Notes
- [ ] `pnpm loop:verify` green on the Linux lab (record in release PR/commit notes if useful)
- [ ] Human approves the tag (agents prepare; do not push `v*` without approval) — see [sdlc.md](sdlc.md)

1. **Bump** root `package.json` `version` (and keep `apps/node-agent` version stamped by packaging / aligned in repo).
2. **CHANGELOG.md** — new `## [X.Y.Z] — YYYY-MM-DD` section (Added / Changed / Fixed / Notes).
3. **Commit** on `main`:
   ```text
   Release X.Y.Z: <one-line why>.
   ```
4. **Tag + push** (human gate):
   ```bash
   git push origin main
   git tag -a vX.Y.Z -m "PlayOn Home X.Y.Z"
   git push origin vX.Y.Z
   ```
5. **Watch** `release-home` on playon (packages Windows + Linux Home/Node, GitHub Release, attaches `latest.json`).
6. **Automatic follow-up** (once secrets are set):
   - `notify-site` sends `repository_dispatch` → playon-games  
   - playon-games syncs installers + `public/home/latest.json` (strict: all four platform assets)  
   - Commits the sync, then `pnpm build` + `wrangler pages deploy` to production  
7. **Verify**:
   ```bash
   curl -fsSL https://playon.games/home/latest.json
   # expect "version":"X.Y.Z" and home/node linux-x64 + windows-x64 sha256 entries
   # Windows node downloadUrl should be playon-node-*-windows-x64.tar.gz (#868)
   gh release view vX.Y.Z --repo gmcclelland90/playon
   ```
8. **Learn** — skim CHANGELOG Fixed; file `test-debt` issues for any `P0`/`P1` fix without a regression test ([testing-plan.md](testing-plan.md)).

Hosts on ≥0.1.5 then see **Update & restart** in the admin UI. Jumping from older builds still uses the one-liner once.

## Manual fallback (if Actions secrets missing)

```bash
# after release-home succeeds
gh release download vX.Y.Z --repo gmcclelland90/playon --pattern 'playon-home-*' --dir dist-home --clobber
gh release download vX.Y.Z --repo gmcclelland90/playon --pattern 'playon-node-*' --dir dist-node --clobber
node scripts/sync-install-scripts.mjs
node scripts/publish-home-manifest.mjs   # writes sibling playon-games/public/home/
cd ../playon-games
git add public/home public/install* public/ensure-docker
git commit -m "Sync PlayOn vX.Y.Z OTA manifest and installers."
git push origin master
# If deploy-pages secret is set, push deploys. Else:
pnpm build && npx wrangler pages deploy dist --project-name=playon-games --branch=master
```

## Site-only changes (docs / skills / marketing)

In **playon-games** only:

```bash
# skills
pnpm catalog
git add skills-src public/skills
git commit -m "…"
git push origin master   # deploy-pages.yml builds + deploys
```

Install script source of truth remains **playon** `deploy/bootstrap/*` and `deploy/install-node.sh` — change there, then `node scripts/sync-install-scripts.mjs` into playon-games (or ship via a Home tag so release sync does it).

## Static asset routing (playon.games)

`public/_routes.json` must **exclude** paths served as plain files (otherwise the Astro Worker returns HTML):

- `/home`, `/home/*` — OTA manifest  
- `/skills`, `/skills/*` — catalog  
- `/install`, `/install.ps1`, `/install-node`, `/ensure-docker`

`public/_headers` sets short cache for `latest.json` (`max-age=60`).

## Checklist

- [ ] Version + CHANGELOG on playon `main`  
- [ ] Tag `vX.Y.Z` pushed  
- [ ] `release-home` green (4 archives + `latest.json` on the GitHub Release)  
- [ ] `deploy-pages` green on playon-games (sync + Cloudflare deploy)  
- [ ] `https://playon.games/home/latest.json` shows the new version and four assets  
- [ ] Spot-check install one-liner docs / `/docs/changelog` if release notes changed  

## Related

- [deploy.md](deploy.md) — host install / ops  
- [agent-dev-loop.md](agent-dev-loop.md) — lab verify before release  
- Sibling playon-games README — local site + catalog  
