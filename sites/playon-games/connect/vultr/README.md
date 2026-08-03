# Vultr OAuth relay (connect.playon.games)

This directory documents the public relay surface for Vultr Connect (design-docs/14).

## Endpoints (to host on playon.games / Cloudflare Worker)

| Path | Role |
|------|------|
| `GET /vultr/start` | Accepts `state`, `code_challenge`, `install_callback`, `client_id` → redirects to Vultr authorize with fixed `redirect_uri` |
| `GET /vultr/callback` | Vultr redirects here with `code` + `state` → POSTs `{ state, code }` to `install_callback` once → shows “you can close this window” |

The relay **must not** store access or refresh tokens. Tokens are exchanged only on the self-hosted control plane (`POST /api/settings/cloud/vultr/callback`).

Worker/Pages implementation is separate from the monorepo control plane; keep redirect URI registered exactly as `https://connect.playon.games/vultr/callback`.
