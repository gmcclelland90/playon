# MVP exit checklist

PlayOn MVP is ready for a LAN demo when all items below are green.

## Prove (automated)

- [ ] `pnpm loop:verify` passes on Windows and Linux CI
- [ ] `pnpm --filter @playon/api test:int` covers auth, servers, chat history, confirm/events where present
- [ ] `pnpm test:agent` / agent-replay covers install + confirm deny/approve
- [ ] Optional: `pnpm loop:verify:runtime` on a Docker host (Paper smoke)
- [ ] Optional: `pnpm test:e2e` Playwright smoke (setup → login → panel)

## Function (product)

- [ ] First-run Owner bootstrap + login
- [ ] Mock LLM can create Paper / fake-http server + publish panel
- [ ] Servers page: create / start / stop / restart + live logs over WS
- [ ] Chat: tool visibility, confirm Approve/Deny, streaming tokens
- [ ] Player `/play`: join address copy, readiness, vote when present
- [ ] Secrets encrypted at rest; redaction on audit traces
- [ ] Snapshots create/restore (restore gated by confirm)

## LAN host

- [ ] Documented Linux host path ([linux-dev-host.md](linux-dev-host.md), [lan-install.md](lan-install.md))
- [ ] `PLAYON_ADVERTISE_HOST` set to LAN IP; players can join published address
- [ ] Docker Engine available for real Paper path (or mock for dry runs)

## Offline / local LLM

- [ ] Ollama profile documented ([ollama-offline.md](ollama-offline.md))
- [ ] Settings UI can switch to `ollama` without cloud keys

## Polish (human gate)

- [x] Impeccable audit/polish on admin + player UI to an excellent score
- [x] Host confirms visual brand / first-viewport quality
