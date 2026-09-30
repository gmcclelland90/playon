# Project Zomboid Workshop publish (dry-run)

AI-authored PZ mods stay under `mods-src/<modId>/` and deploy server-locally via `mods_deploy`. Publishing to **Steam Workshop** is a separate, human-gated step.

## Tool

`mods_workshop_prepare` (confirm-gated, maintain catalog):

1. Validates `playon-mod.json` dialect is `project-zomboid`.
2. Zips workspace files (minus `playon-mod.json` / `playon-deploy.json`) as `mods/<modId>/…`.
3. Writes `workshop-out/<modId>/<modId>-workshop.zip` and `workshop-preview.json` in the server jail.
4. **Never** uploads to Steam.

### Live publish

Pass `livePublish: true` only when the host wants a real upload. PlayOn always returns:

```json
{ "error": "blocked_human", "code": "steam_credentials_human_gate" }
```

Steam account ownership and Workshop credentials remain **blocked-human** until configured on the host. The dry-run zip is still staged so a human can upload manually.

## Related

- `docs/ai-modding-loop.md`
- `docs/workshop-watcher.md` (update notify for *existing* Workshop items — different path)
- Epic #988 / issue #999
