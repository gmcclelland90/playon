# 19 – Windows WSL2 Linux runtime

> **Status:** Approved — epic [#293](https://github.com/gmcclelland90/playon/issues/293).  
> **Working names:** Linux runtime (WSL) · `local-wsl` / `{nodeId}-wsl` · Enable Linux runtime  
> **Locked defaults:** Docker Engine in WSL · distro `playon-linux` · sibling Linux node on the Windows host · MVP = WSL node only (no Docker Desktop shortcut in MVP)

## One-liner

Offer **Enable Linux runtime** on any Windows **node** (Home may be Linux or Windows) so WSL2 enrolls a sibling Linux compute node against that Home — same mental model as **Install Docker** on Linux nodes.

## Problem

Many catalog skills are linux-only (or Linux-native Steam/Docker). Windows hosts are common, but:

- Placement marks Windows nodes `os_mismatch:windows` for `os: [linux]` skills.
- Lab and production often run **Home on Linux** with a Windows node attached — WSL must not require Home to be on Windows.
- The only escape hatch used to be Add node (another Linux host or cloud VPS).

Hosts should not need a spare Linux box for a LAN night if WSL2 can host the workload on the same Windows PC.

## Non-goals

- Do **not** run the control plane / Home UI inside WSL by default.
- Do **not** replace Windows Local / Windows nodes for PE / Windows-only skills.
- Do **not** pretend Windows native can exec Linux binaries without a linux node.
- Do **not** nest agents (“node on a node”) — WSL adds a **sibling** worker on the same host.

## Architecture

WSL is a **Windows host capability**. Enabling it starts a second agent on that machine; both heartbeat to whatever Home the Windows node already uses.

**One Windows box (Home on that PC):**

```text
Windows host
├── PlayOn Home (control plane + UI)
├── node-agent id=local        os=windows   ← PE / Windows-native
└── WSL2 distro (playon-linux)
    └── node-agent id=local-wsl os=linux docker=true
```

**Lab / mixed (Home on Linux):**

```text
Linux Home
     ↑ heartbeat          ↑ heartbeat
Windows host
├── node-agent id=<win>     os=windows
└── WSL2 → node-agent id=<win>-wsl  os=linux docker=true
```

Placement, File Store, and node jobs stay unchanged; WSL is capacity, not a second product mode.

### Sibling node ids

| Windows node id | WSL sibling id |
|-----------------|----------------|
| `local` | `local-wsl` |
| any other `N` | `N-wsl` |

Badge: `Local · Linux (WSL)` for local placement; `Remote · Linux (WSL)` when the sibling is lan/remote.

## UX (Docker-parallel)

| Surface | Behavior |
|---------|----------|
| Settings → Nodes | **Enable Linux runtime** on each eligible Windows node row (not a Home-global control) |
| Remote Windows / Linux Home | Prefer `wsl_ensure` on an elevated (SYSTEM) Windows node agent; token one-liner only as fallback |
| Windows Home + `local` | Local UAC only if the Local node agent is not already elevated |
| Progress | not installed → reboot/UAC needed → installing → waiting heartbeat → ready |
| Agent | `wsl_status` / `wsl_enable` / `wsl_repair` with optional `nodeId` (Windows node); on `no_eligible_node` / `os_mismatch` offer enable before remote `nodes_add` |

## Phases

0. **Harden placement/create** — refuse create when no eligible node; UI + agent hints ([#294](https://github.com/gmcclelland90/playon/issues/294)).
1. **Bootstrap + API + Settings** — `ensure-wsl-runtime` script, enroll `local-wsl` ([#295](https://github.com/gmcclelland90/playon/issues/295)).
1b. **Agent tools + prompt + platform skill** ([#296](https://github.com/gmcclelland90/playon/issues/296)).
1c. **Node-scoped WSL** — enable from any Home against a Windows node; sibling ids `{nodeId}-wsl`; token one-liner when API is not on that Windows host.
2. **Networking / join** — mirrored networking, `joinHost`, LAN smoke ([#297](https://github.com/gmcclelland90/playon/issues/297)).
3. **Optional** — Windows Docker Desktop eligibility for container-only linux skills; agent `nodes_install_docker` parity.

## Decisions (locked)

1. **Docker:** Engine inside the WSL distro (not Docker Desktop for MVP).  
2. **Distro:** pinned name `playon-linux`.  
3. **Node:** sibling of the Windows node (`local-wsl` or `{nodeId}-wsl`); not nested under the Windows agent process.  
4. **MVP:** full WSL node only; Windows Docker Desktop eligibility for container skills is Phase 3.  
5. **Home OS:** irrelevant — WSL setup runs on the Windows host (local UAC or elevated one-liner).

## Success metrics

- Windows-only hosts can complete a linux docker skill install without a second machine.
- Linux Home + Windows node can enable WSL and place linux skills on `{nodeId}-wsl`.
- Agent resolve rate on `os_mismatch` (enable WSL or add node) vs blind create failures.
- LAN join success for WSL-placed servers (Phase 2).

## Related

- [14 – Per-server compute placement](14-cloud-backed-lan-mode.md)
- [05 – Runtime & node management](05-runtime-and-node-management.md)
- Deploy: Install Docker on Linux nodes (`docs/deploy.md`)
