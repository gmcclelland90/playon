# LAN content cache

PlayOn can use a [LANCache](https://lancache.net)-compatible HTTP cache so SteamCMD (and LAN party PCs) reuse downloaded content on the LAN instead of the WAN.

## Modes

1. **BYO** — Point Settings → LAN cache at an existing cache IP. Optionally enable **Pin SteamCMD** so node-agents write Steam CDN names into the system hosts file (requires elevation if the agent cannot write hosts).
2. **Managed** — Install `lancachenet/monolithic` on a **Linux + Docker** node from Settings. Optional `lancachenet/lancache-dns` so DHCP can point at that node for full wildcard CDN coverage.

Windows nodes can *use* a cache; only Linux nodes can *run* the managed stack.

## Tips

- Prefer DHCP/router DNS aimed at the cache (or managed DNS) for party PCs.
- Hosts-file pin is a SteamCMD helper for hosts that cannot change router DNS; it covers known concrete Steam CDN names only.
- Cache data lives under `PLAYON_DATA_ROOT/lancache` by default on the party node.
- Soft disk warnings appear in Settings; prune is manual (no silent LRU).
- Each game server still gets its own `game/` install — caching saves bandwidth, not disk.

See [design-docs/19-lan-content-cache.md](../design-docs/19-lan-content-cache.md).
