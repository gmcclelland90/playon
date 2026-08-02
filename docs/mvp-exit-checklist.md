# MVP exit checklist

PlayOn MVP is ready for a LAN demo when all items below are green.

## Prove (automated)

- [x] `pnpm loop:verify` passes on the **Linux lab host** (real Venice + Docker)
- [x] `pnpm --filter @playon/api test:int` covers Paper Docker, Venice chat, RCON, SteamCMD missing, node-agent jobs
- [x] `pnpm test:agent` / agent-replay covers live Venice tool loop
- [ ] Optional: `pnpm loop:verify:runtime` on a Docker host (Paper smoke)
- [ ] Optional: `pnpm test:e2e` Playwright smoke (setup → login → panel)

## Function (product)

- [x] First-run Owner bootstrap + login
- [x] Venice LLM creates Paper via chat + publish panel (no mock LLM)
- [x] Map / maintain dock: start / stop / restart + live logs over WS
- [x] Chat: tool visibility, confirm Approve/Deny where gated, streaming tokens
- [x] Player `/play`: join address copy, readiness, vote when present
- [x] Secrets encrypted at rest; redaction on audit traces
- [x] Snapshots create/restore (restore gated by confirm)
- [x] RCON against live Paper; SteamCMD fails honest when missing; node-agent job round-trip

## LAN host (production)

- [x] Documented Linux host path ([linux-dev-host.md](linux-dev-host.md), [lan-install.md](lan-install.md))
- [x] One-process start: API serves built web (`pnpm build && pnpm start`)
- [x] systemd unit under `infra/control-plane/`
- [x] Production refuses missing `PLAYON_SESSION_SECRET` / `PLAYON_ADVERTISE_HOST`
- [x] `PLAYON_ADVERTISE_HOST` set on the party box; players can join published address
- [x] Docker Engine available for real Paper path
- [x] Control plane survives reboot (`systemctl enable --now playon`)

## Offline / local LLM

- [ ] Ollama profile documented ([ollama-offline.md](ollama-offline.md))
- [ ] Settings UI can switch to `ollama` without cloud keys

## Polish (human gate)

- [x] Impeccable audit/polish on admin + player UI to an excellent score
- [x] Host confirms visual brand / first-viewport quality
