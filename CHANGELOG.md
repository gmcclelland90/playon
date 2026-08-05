# Changelog

All notable changes to PlayOn Home (root `package.json` version) are listed here.

## [0.1.2] — 2026-08-05

### Added

- **Unified Add-a-node** — Settings → Nodes: add LAN or cloud compute via SSH or a short-lived console one-liner.
- **Cloud WireGuard overlay** — PlayOn configures WireGuard on the VPS and Home; hosts do not manage peers by hand.
- **Home LAN gateway** — TCP/UDP port forward so cloud-placed servers still advertise LAN join addresses on `/play`.
- **Local compute toggle** — Home can be control-plane-only (no Local placement) or also host games.
- Node kinds / placement badges: `Local` · `Remote · name` · `Cloud · name`.
- Relocate syncs server data to the target node (archive jobs) before rebinding.
- Agent tools: `nodes_add`, `nodes_remove`.

### Changed

- Relocate is stop → snapshot → **copy** → rebind → restart (not metadata-only).
- Design doc 14 and deploy notes: BYO + WireGuard first; vendor Connect (Vultr OAuth) deferred.

### Notes

- Cloud nodes require WireGuard tools on Home (`wireguard-tools` or WireGuard for Windows).
- Install-node bootstrap still prefers `https://playon.games/install-node` when reachable.

## [0.1.1] — previous

- Portable Home packages, one-line installers, multi-provider LLM presets, MCP surface.
