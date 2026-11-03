# Clone isolation (all games)

A clone must not inherit another server's name, ports, or save. [#1016](https://github.com/gmcclelland90/playon/issues/1016) was a Project Zomboid clone that kept NewZombieLand3's name, ports 16261/16262, and data dir and took over the live server. [#1049](https://github.com/gmcclelland90/playon/issues/1049) fixed that path for PZ and was checked by hand on that one game. These checks cover the catalog ([#52](https://github.com/gmcclelland90/playon/issues/52)) on Linux and Windows.

Game packages are not in this repo. Both checks read a sibling `playon-games` tree when it is present (`PLAYON_GAMES_SKILLS_ROOT`, `packages-src/games`, or `skills-src/games`). Otherwise they download the public catalog at `https://playon.games/packages/index.json`.

## What is allowed

A package's **own** identity may appear as a fallback for the variables Home rewrites per server:

- `${PLAYON_SERVER_NAME:-servertest}` and `${PLAYON_GAME_PORT:-16261}`
- Windows `if not defined VAR set VAR=literal`
- the ports declared in `metadata.yaml` (`name`, `protocol`, `default`)

[#1050](https://github.com/gmcclelland90/playon/issues/1050): a server's own start script may name **that** server, including an unused fallback. The same literal on a different server is foreign and fails. `scanServerScript` is the contract the unit test locks in. Home's PZ rewriter (`pz-start-identity.ts`) is a separate change.

A literal a copied file would keep with no env indirection is `inherited_port`, `inherited_name`, or `inherited_path` (Bannerlord `/port 7210`, a docker `CS2_PORT`, Terraria `-world`, and the same pattern). Home does not rewrite those yet. They are listed in `scripts/clone-isolation-allowlist.json` with a justification of at least 40 characters. The live check still **refuses** to start that clone, so the waiver is not a pass to share the live bind.

These cannot be waived:

- `foreign_name` — another server's name (NewZombieLand3, NZLCloneFrontierRD)
- `foreign_port` — a live port the package did not declare (16261/16262 on a non-PZ package)
- `foreign_path` — `servers/<some other id>/`
- `identity_undeclared` — a package with no ports

A stale allowlist entry (the finding is gone, or the package left the catalog) fails the static check.

## Static check (every PR)

```bash
pnpm lab:clone-isolation-static
node scripts/clone-isolation-static.mjs --root ../playon-games/packages-src/games
node scripts/clone-isolation-static.mjs --catalog --cache tmp/clone-isolation-catalog
node scripts/clone-isolation-static.mjs --skill games.project-zomboid
```

GitHub Actions job **Clone isolation (static)** in [`.github/workflows/ci.yml`](../.github/workflows/ci.yml) runs the catalog scan and a dry-run of the live plan on `ubuntu-latest` for every PR, including forks. It uses no secrets. `pnpm verify` also runs `node scripts/clone-isolation.test.mjs` on Ubuntu and Windows. That test is the dry-run and the loopback stand-in (isolate and refuse), plus the production-host guard and a fake Home phase.

This is the check to mark required. It does not need a self-hosted runner.

## Live check (lab hosts)

For each selected package the runner OS can host, the check:

1. Starts a loopback stand-in for a fake live server (`lab-live-<game>`). The stand-in binds `127.0.0.1` only, writes a save sentinel, and does not launch a game binary.
2. Copies that server's start settings onto `lab-clone-<game>` and rewrites `PLAYON_SERVER_NAME`, `PLAYON_SERVER_ID`, `PLAYON_GAME_PORT`, and `PLAYON_HOME` to the clone.
3. Asserts the stand-in's pid, save hash, and ports are unchanged.
4. If the package reads per-server env, starts a second stand-in on the clone's ports (declared port + 1000) and its own save. If the package hardcodes identity, does **not** start the clone and expects `start_identity_collision`, `start_port_collision`, `start_identity_foreign_home`, or `start_config_missing`.
5. Deletes the stand-ins and the temp dirs. It never kills a process it did not spawn. A port already in use is `port_busy` and fails that package.

Linux selection: `os` includes `linux`, or `containerSupport` is `full` / `partial`. Windows selection: `os` includes `windows`, or the package is containerized, so WSL and Docker packages run on the Windows lab host too. The default run is the full set for that OS, serially. Nightly uses that default. `--skill`, `--limit`, and `--shard 1/4` narrow it. `--port-base 40000` binds a private range when the machine cannot take the catalog ports.

```bash
pnpm lab:clone-isolation -- --dry-run
pnpm lab:clone-isolation -- --skill games.valheim
pnpm lab:clone-isolation -- --host windows --limit 5
pnpm lab:clone-isolation -- --port-base 40000 --report tmp/clone-isolation-live.json
```

`--dry-run` prints the isolate/refuse plan and does not bind or call Home.

### Home phase

`--home off` (the default, and what CI and the nightly lab job use) never calls Home.

`--home auto` runs the Home phase when `PLAYON_LAB_HOME_SESSION` is set, and skips it otherwise. `--home on` exits 1 when the cookie is missing. `PLAYON_LAB_HOME_API` defaults to `http://127.0.0.1:8787`.

The cookie is an operator **session** cookie (`playon_session`), minted on a lab Home. Do not put the production Home's cookie in the runner environment or in GitHub secrets for this workflow. The workflow does not receive repository secrets.

The phase lists `/api/servers` and **stops** if that Home already has NewZombieLand3, Hub, Frontier, or any name containing `newzombieland` (lab-live-* / lab-clone-* are ignored). It then creates only `lab-live-*` and `lab-clone-*` servers, takes a snapshot, writes a rewritten start env under each data dir, and deletes those servers. It does not `POST /start` unless you pass `--home-start`. That flag can launch a real dedicated server. Leave it off unless the Home is a disposable lab instance.

`PLAYON_PRODUCTION_HOST=1` makes the live script exit 2 before it binds or calls Home. Set that on the production host.

## Lab runners

Workflow: [`.github/workflows/clone-isolation-lab.yml`](../.github/workflows/clone-isolation-lab.yml).

| Trigger | What runs |
|---------|-----------|
| `pull_request_target` whose diff touches server, clone, snapshot, runtime, or this check | Stand-in on both OS labels, for same-repo PRs from OWNER / MEMBER / COLLABORATOR |
| Schedule `30 7 * * *` (after nightly-docker) | Full stand-in for each OS, `--home off` |
| `workflow_dispatch` | Same, with optional skill, limit, port base, home mode |

Job names **Clone isolation (linux)** and **Clone isolation (windows)** are the status checks. They run on `[self-hosted, playon-lab-linux]` and `[self-hosted, playon-lab-windows]`.

### Do not use the production host

Register the runner on a machine that does **not** serve live player servers.

- Do **not** install it on `playon-dev` (`172.16.0.156`), the Home that runs NewZombieLand3, Hub, and Frontier.
- Do **not** install it on a friend-hosting node.
- `playon-win-1` (`172.16.0.94`) joins that Home and places Windows games for the matrix. Prefer a separate Windows lab box. If that worker is the only Windows machine, dispatch with a `port_base` so the stand-in does not bind catalog ports a live game holds, and do not set `home=on` against `172.16.0.156`.
- `playon-node-1` is not a clone-isolation runner.
- On the production host, set `PLAYON_PRODUCTION_HOST=1` so a mis-registered runner exits before it binds.

The stand-in listens on loopback only. It still occupies the package's declared ports unless `port_base` is set, and a second process on those ports is the bug this check exists to catch.

### Security

The lab workflow is `pull_request_target`, so GitHub runs the workflow file from the default branch. A fork cannot replace that file and land a job on the runner. A gate job then allows a checkout only when all of these hold:

- the head repository is `gmcclelland90/playon`
- `head.repo.fork` is false
- `author_association` is `OWNER`, `MEMBER`, or `COLLABORATOR`
- the head SHA is 40 hex characters

Checkout uses `persist-credentials: false`. The workflow permissions are `contents: read`. No `secrets` context is passed. The job does not run `pnpm install`, so a PR cannot execute dependency lifecycle scripts on the runner. Fork PRs and first-time contributors skip the lab jobs. The static job in `ci.yml` still runs for them on GitHub-hosted runners.

Path filters mean the lab checks are **absent** on PRs that do not touch those paths. An absent check is not a failure. That is why the unfiltered static job is the one to require. Do not mark the self-hosted jobs required until both runners are online: a missing label queues the job (GitHub eventually times out the queue) and a required queued check blocks merges.

### Register a Linux runner

On a lab box that is not the production host, as a dedicated user (not the account that runs player servers):

1. Install Git and curl. Node is supplied by `actions/setup-node` in the job. The machine needs outbound HTTPS to GitHub, `nodejs.org`, and `playon.games`.
2. In the repo: **Settings → Actions → Runners → New self-hosted runner → Linux**.
3. Run the download and config commands GitHub shows. Add the label `playon-lab-linux` and a name you can recognize, for example `playon-lab-linux`:

```bash
./config.sh --url https://github.com/gmcclelland90/playon --token <one-time token from that page> \
  --name playon-lab-linux --labels playon-lab-linux --unattended
sudo ./svc.sh install
sudo ./svc.sh start
```

GitHub also applies `self-hosted`, `Linux`, and `X64`. The workflow asks for `self-hosted` and `playon-lab-linux`.

Leave `PLAYON_PRODUCTION_HOST` unset here. If this runner should talk to a **lab** Home, put `PLAYON_LAB_HOME_SESSION` and `PLAYON_LAB_HOME_API` in the service environment, not in the repo. The nightly job does not read them (`--home off`). A manual run with `home=auto` will.

Confirm the runner is Idle on the Runners page, then **Actions → clone-isolation-lab → Run workflow**.

### Register a Windows runner

Same rule: a lab box that is not serving players. **Settings → Actions → Runners → New self-hosted runner → Windows**.

In an elevated PowerShell, from the extracted runner directory:

```powershell
./config.cmd --url https://github.com/gmcclelland90/playon --token <one-time token from that page> `
  --name playon-lab-windows --labels playon-lab-windows --unattended --runasservice
```

The extra label is `playon-lab-windows`. GitHub adds `self-hosted`, `Windows`, and `X64`. The workflow asks for `self-hosted` and `playon-lab-windows`.

Outbound HTTPS is required (GitHub, Node, `playon.games`). Do not set `PLAYON_PRODUCTION_HOST` on this box.

### Remove a runner

`./svc.sh stop` then `./svc.sh uninstall` (Linux), or stop and uninstall the Windows service from an elevated shell, then remove the runner on the GitHub Runners page. Do this immediately if a runner was registered on the production host by mistake.

## What is left to enable

1. Register the two runners with the labels above, on machines that are not `playon-dev` and do not host live players.
2. Set `PLAYON_PRODUCTION_HOST=1` on the production host.
3. After **Clone isolation (static)** is green on this PR, mark that job required. Leave the linux/windows lab jobs optional until the runners have completed a manual run.
4. Optional: a lab-only `PLAYON_LAB_HOME_SESSION` on the runner, then `workflow_dispatch` with `home=auto`. Keep `home_start` false.
5. The allowlisted packages still bake their own catalog default into the launch files. Clearing an entry means changing that package in `playon-games` so the literal is only an env fallback, then deleting the allowlist row. The static check fails if the row stays behind.
