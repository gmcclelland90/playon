# Mod assets via fal.ai (bring your own key)

PlayOn can generate assets for AI-authored mods using **your** fal.ai API key. PlayOn never bills fal and never shows the key back or sends it to the player panel.

## Setup

1. Create an API-scoped key at [fal.ai/dashboard/keys](https://fal.ai/dashboard/keys).
2. In PlayOn **Settings → Mod assets**, paste the key and Save.
3. Leave the field blank later to keep the saved key; use **Clear key** to remove it.

## Agent tool

`mods_assets_generate` (confirm-gated, maintain catalog):

- Requires a saved fal key (`fal_key_missing` otherwise, with the dashboard hint).
- Writes under `mods-src/<modId>/assets/` only (jailed). The result's `placementHint` says where to copy it inside `mods-src/<modId>/` so the game loads it (for example PZ icons go to `media/textures/Item_<name>.png`).
- Runs through fal's queue API (`queue.fal.run`), polls until done, and gives up after 5 minutes (the request is cancelled). The key is only sent to `queue.fal.run`; result files are downloaded from fal's CDN without it, capped at 25 MB.

| kind | What you get | Models (first is default) |
|------|--------------|---------------------------|
| `image` | Raw text-to-image PNG, full size | `fal-ai/flux/schnell`, `fal-ai/flux/dev` |
| `sprite` | Same, background removed (`fal-ai/birefnet`) | same |
| `icon` | Sprite resized to the game's icon size | same |
| `texture` | Square, resized to the game's texture size | same |
| `sound` | Short clip (`seconds` 1–47, default 5) | `fal-ai/stable-audio` |

Default sizes: icons are 32px for Project Zomboid and Terraria, 16px for Minecraft, 64px for Factorio and others; textures are 16px for Minecraft and 256px otherwise. Pass `size` (16–1024, powers of two) to override. Images are centre-cropped to a square and never upscaled.

Other model ids are refused with `fal_model_not_allowed` so the agent can't run an expensive model on your key.

## Out of scope

PlayOn-billed fal credits or spend caps. 3D models (no supported game loads fal's GLB output directly yet).

## Live smoke

`pnpm smoke:fal` makes a PZ-size icon and a 2-second sound with the key saved in Settings (or `FAL_KEY`), writes them to a temp folder, and prints `fal_smoke=ok`. It touches no game server and costs a few cents of fal credit. Pass kinds to choose: `pnpm smoke:fal icon texture sprite`. It fails unless the output is game-loadable: a 32×32 PNG with transparency for an icon, 256×256 for a texture, real audio bytes for a sound.

### In CI

`.github/workflows/fal-live.yml` runs the same smoke against real fal weekly, on PRs that touch the fal code, and on demand (Actions → fal-live → Run workflow, with a choice of kinds). It needs a `FAL_KEY` repo secret (Settings → Secrets and variables → Actions) and skips cleanly without one. Generated files are uploaded as the `fal-smoke-output` artifact so you can look at them.
