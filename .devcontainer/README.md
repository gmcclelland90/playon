# PlayOn devcontainer

Linux-primary agent loop environment (Node 22, pnpm, Docker-in-Docker).

## Open

In VS Code / Cursor: **Dev Containers: Reopen in Container**.

After create: `pnpm install` runs automatically. Fast verify runs on start.

## Env defaults

- `PLAYON_LLM_MODE=mock`
- `PLAYON_RUNTIME=mock` (switch to `docker` for Paper smoke inside the container)

## Commands

```bash
pnpm loop:verify
pnpm loop:verify:runtime   # needs Docker feature healthy
pnpm dev
```

Host machine notes without a container: [docs/dev-setup.md](../docs/dev-setup.md), [docs/linux-dev-host.md](../docs/linux-dev-host.md).
