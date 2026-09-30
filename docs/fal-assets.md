# Mod assets via fal.ai (bring your own key)

PlayOn can generate image assets for AI-authored mods using **your** fal.ai API key. PlayOn never bills fal and never shows the key back or sends it to the player panel.

## Setup

1. Create an API-scoped key at [fal.ai/dashboard/keys](https://fal.ai/dashboard/keys).
2. In PlayOn **Settings → Mod assets**, paste the key and Save.
3. Leave the field blank later to keep the saved key; use **Clear key** to remove it.

## Agent tool

`mods_assets_generate` (confirm-gated, maintain catalog):

- Requires a saved fal key (`fal_key_missing` otherwise, with the dashboard hint).
- Writes under `mods-src/<modId>/assets/` only (jailed).
- Default model: `fal-ai/flux/schnell`.

## Out of scope

PlayOn-billed fal credits or spend caps.
