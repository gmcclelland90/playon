# 19 – Windows WSL2 Linux runtime

> **Status:** Approved — epic [#293](https://github.com/gmcclelland90/playon/issues/293).  
> **Working names:** Linux runtime (WSL) · `local-wsl` · Enable Linux runtime  
> **Locked defaults:** Docker Engine in WSL · distro `playon-linux` · node id `local-wsl` / kind `local` / badge `Local · Linux (WSL)` · MVP = WSL node only (no Docker Desktop shortcut in MVP)

## One-liner

Keep PlayOn Home on Windows; offer a one-click **Linux runtime** that enrolls a WSL2-backed compute node so linux-only skills can run without a second physical machine — same mental model as **Install Docker** on Linux nodes.

## Problem

Many catalog skills are linux-only (or Linux-native Steam/Docker). Windows Home is a supported install path, but today:

- Placement marks Local `os_mismatch:windows` for `os: [linux]` skills.
- Create could still materialize with `nodeId: null` and start on Windows Local (Phase 0 closes this).
- The only escape hatch is Add node (another Linux host or cloud VPS).

Hosts should not need a spare Linux box for a LAN night if WSL2 can host the workload on the same PC.

## Non-goals

- Do **not** run the control plane / Home UI inside WSL by default.
- Do **not** replace Windows Local for PE / Windows-only skills.
- Do **not** pretend Windows native can exec Linux binaries without a linux node.

## Architecture

```text
Windows host
├── PlayOn Home (control plane + UI)
├── node-agent id=local        os=windows   ← PE / Windows-native
└── WSL2 distro (e.g. playon-linux)
    └── node-agent id=local-wsl os=linux docker=true
         ← containers + native/Steam Linux
```

Placement, File Store, and node jobs stay unchanged; WSL is capacity, not a second product mode.

## UX (Docker-parallel)

| Surface | Behavior |
|---------|----------|
| Settings → Nodes | **Enable Linux runtime** when Home is Windows and `local-wsl` is missing/unhealthy |
| Progress | not installed → reboot/UAC needed → installing → waiting heartbeat → ready |
| Badge | `Local · Linux (WSL)` |
| Agent | `wsl_status` / `wsl_enable` (confirm) / `wsl_repair`; on `no_eligible_node` / `os_mismatch` offer enable before remote `nodes_add` |

## Phases

0. **Harden placement/create** — refuse create when no eligible node; UI + agent hints ([#294](https://github.com/gmcclelland90/playon/issues/294)).
1. **Bootstrap + API + Settings** — `ensure-wsl-runtime` script, enroll `local-wsl` ([#295](https://github.com/gmcclelland90/playon/issues/295)).
1b. **Agent tools + prompt + platform skill** ([#296](https://github.com/gmcclelland90/playon/issues/296)).
2. **Networking / join** — mirrored networking, `joinHost`, LAN smoke ([#297](https://github.com/gmcclelland90/playon/issues/297)).
3. **Optional** — Windows Docker Desktop eligibility for container-only linux skills; agent `nodes_install_docker` parity.

## Decisions (locked)

1. **Docker:** Engine inside the WSL distro (not Docker Desktop for MVP).  
2. **Distro:** pinned name `playon-linux`.  
3. **Node:** durable id `local-wsl`, kind `local`, badge `Local · Linux (WSL)`.  
4. **MVP:** full WSL node only; Windows Docker Desktop eligibility for container skills is Phase 3.

## Success metrics

- Windows-only hosts can complete a linux docker skill install without a second machine.
- Agent resolve rate on `os_mismatch` (enable WSL or add node) vs blind create failures.
- LAN join success for WSL-placed servers (Phase 2).

## Related

- [14 – Per-server compute placement](14-cloud-backed-lan-mode.md)
- [05 – Runtime & node management](05-runtime-and-node-management.md)
- Deploy: Install Docker on Linux nodes (`docs/deploy.md`)
