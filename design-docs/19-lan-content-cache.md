# 19 – LAN Content Cache

## Intent

Optional LAN content caching for PlayOn hosts and LAN-party clients:

1. **Internal efficiency** — repeated SteamCMD `+app_update` downloads hit a local HTTP cache instead of the WAN.
2. **LANCache in PlayOn** — operators can BYO an existing [LANCache](https://lancache.net) or install upstream `lancachenet/monolithic` (+ optional DNS) on a Linux Docker node.

Same cache engine for both surfaces; difference is UX/DNS scope, not a second proxy implementation.

## Audience

- Host path first (SteamCMD on PlayOn nodes).
- LAN players second (DHCP/DNS → cache for Steam/Epic/etc. on party PCs).

## Decisions

| Topic | Choice |
|--------|--------|
| Engine | Upstream `lancachenet/monolithic` (+ optional `lancachenet/lancache-dns`) |
| Topology | Per-node client pin by default; optional “party node” running managed stack |
| Native vs party | Same engine; “native” = node-local/BYO use without owning LAN DNS |
| Steam materialization | Bandwidth only — each server jail still gets a full `game/` tree |
| Host → cache attach | Router/DHCP DNS tip sheet + optional Steam CDN hosts-file pin for SteamCMD |
| Disk | Soft warn defaults + manual prune; no silent LRU |
| Platforms | Cache *services* Linux+Docker only; Windows nodes are clients |
| Product surface | Settings + node capability badges (`lancache`, pin status) |

## Sequencing

1. **Slice 1** — Settings (`lancache` key), BYO cache IP, tip sheet, heartbeat-delivered pin config, hosts-file Steam CDN pin, reachability badge, free-disk soft warn.
2. **Slice 2** — Managed install via node jobs (`lancache_ensure`, optional DNS, status/stop/prune), party node picker, cache-dir warn.

## Config

Fleet settings key `"lancache"`: `enabled`, `cacheIp`, `pinSteamcmd`, warn thresholds, `partyNodeId`, `manageDns`, `dataPath`.

Agents receive `{ enabled, cacheIp?, pinSteamcmd }` on heartbeat response (no separate poll).

## Non-goals (v1)

- Shared/hardlinked installs across server jails
- Docker registry mirror / `fetch_url` blob cache
- Windows-hosted cache containers
- PlayOn-owned CDN cache implementation
- Silent LRU eviction
- Forcing PlayOn as the LAN DNS server by default

## Related

- Runtime / nodes: [05](05-runtime-and-node-management.md)
- Cloud-backed LAN / placement: [14](14-cloud-backed-lan-mode.md)
- Roadmap: [13](13-extensibility-and-roadmap.md)
