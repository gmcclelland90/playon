# 14 – Per-Server Compute Placement (exploratory)

> **Status:** Idea capture / parking lot — not committed for v1.  
> **Working names:** Compute placement · Run-where · Local / Remote / Cloud  
> **Earlier framing:** “Cloud-backed LAN mode” — refined below into a **per-server** choice, not a global product mode.

## One-liner

When creating (or moving) a game server, the host picks **where it runs**: on this machine, on another computer on the LAN, or on a nearby cloud VPS — with cloud join paths tunneled so it still feels LAN-local.

## Problem

Hosts have uneven hardware:

- The PlayOn box may be a laptop that shouldn’t run heavy dedicated servers.
- There may be a spare PC or mini-PC on the same network that *can*.
- Sometimes nothing on-site is enough, and a nearby VPS is the only practical horsepower.

The common real-world case is **hybrid**, not all-or-nothing: they *do* have a machine (or a few) that can run some servers, but not enough local compute for the whole party. They need to keep what fits on-site and **burst the overflow to cloud** without changing how they manage anything.

A single global “cloud mode” is too coarse. Different games in the same party need different homes (light proxy locally, chunky modpack in the cloud, Windows-only title on the spare rig).

## Core idea: placement is per server

Each managed server has a **compute placement** (working enum):

| Placement | Meaning | Runs on |
|-----------|---------|---------|
| **Local** | Use the machine PlayOn is installed on (control-plane host / primary node). | Install host |
| **Remote** | Use another registered computer on the same network. | LAN node |
| **Cloud** | Provision or attach a nearby VPS and run there; tunnel so LAN join still works. | VPS node |

Same admin chat, skills, snapshots, and player panel — only the **node target** (and networking path) changes.

Agents can still help choose (“Minecraft + heavy mods → cloud or the spare desktop; small proxy → local”), but the host always has an explicit override.

## Desired experience

1. Host asks for a server as usual (or uses create UI).
2. Placement step (or agent suggestion + confirm):
   - **Local** — “this machine”
   - **Remote** — pick a LAN node (or “any with enough free RAM”)
   - **Cloud** — nearby VPS (BYO / partner; see below)
3. Server files + runtime land on the chosen node.
4. Players get join info from the player panel. For **Cloud**, that path goes through a LAN presence / tunnel so they aren’t hunting public IPs.
5. Later, the host can **move** a server between placements (local ↔ remote ↔ cloud), with snapshot + transfer as the safety rail.

**North star feel:** “Each server lives where it should — and the party still feels like one LAN.”

**Hybrid feel:** “We filled the spare box first; the extras just came up in cloud for the night.”

## How this maps to existing architecture

This is a UX + scheduling layer on top of the node model, plus cloud-specific networking.

| Piece | Placement-agnostic? | Notes |
|-------|---------------------|--------|
| Admin UI + player panel | Yes | Always served from control plane |
| Agent / control plane | Yes | Stays on the install host (preferred) |
| Game runtime | No | Bound to the server’s chosen node |
| Snapshots / server dirs | No | Live with the workload node; may copy on move |
| Join path | Mostly | Local/Remote = normal LAN ports; Cloud = tunnel + local gateway |

Existing concepts that already help:

- **Multi-node mode** — Remote is basically “pin this server to node X”.
- **Blank / provisionable nodes** — Cloud is IaC blank node + lifecycle (create/sleep/destroy).
- **Agent node selection** — today agents/host pick a suitable node; placement makes that a first-class field.

What is new:

- Explicit **per-server placement** enum in product language (Local / Remote / Cloud), not only internal node IDs.
- **Cloud** as a placement that can **spin capacity on demand**, not only attach a pre-existing node.
- **LAN presence tunneling** when placement is Cloud (and optionally when Remote is awkward).
- **Move between placements** as a supported lifecycle action.

## Placement details

### Local

- Default for simple installs and light servers.
- Same machine as the control plane unless the host has already split topology.
- Honest about resource contention with the UI/LLM if both are busy.

### Remote (same network)

- Requires at least one other registered node on the LAN.
- Host picks a specific machine, or “best fit” from free CPU/RAM/disk and OS compatibility.
- No VPS billing; trust model stays “our hardware”.
- Natural fit for the spare PC / mini-PC / “blank node” story already in [05](05-runtime-and-node-management.md).

### Cloud (nearby VPS)

- Spin up or attach a VPS close enough that the party still plays well.
- Tunnel / overlay + local gateway so join feels LAN-local (see networking below).
- Capacity can be shared across multiple **Cloud**-placed servers on one VPS, or one VPS per heavy server (policy TBD).
- Prefer **BYO VPS** (and optional partner) over PlayOn-operated multi-tenant hosting — keeps the self-host story intact.

#### What “nearby” means

- Region / city near the party
- Measured RTT from LAN egress to the VPS
- Game-specific latency tolerance
- Cost vs latency the host accepts

**Hard rule:** never default a region by provider popularity or “cheapest worldwide.” An AU party must not land on US-East. Region choice is always **proximity / measured latency first**, price second.

### Cloud provider shortlist (exploratory)

Goal: one (then a few) providers that can place a box **near the party** in most of the world, with simple API + hourly billing so burst capacity can die when the LAN ends.

| Provider | Global density (approx.) | AU / local-to-PlayOn relevance | Fit notes |
|----------|--------------------------|----------------------------------|-----------|
| **Vultr** | ~33 cities — strongest mid-tier footprint | **Sydney + Melbourne** | Hourly billing, game-hosting friendly, good APAC spread (Tokyo, Seoul, Singapore, India, …). Strong **first integration** candidate. |
| **Linode / Akamai Cloud** | ~25+ | **Sydney** + strong APAC | Solid API/Terraform story; Akamai backbone. Good #2 or multi-provider peer. |
| **DigitalOcean** | ~15 regions | **Sydney** | Great DX/docs; fewer cities than Vultr — fine where it has coverage, weaker as sole global bet. |
| **OVHcloud** | ~30+ DCs (EU-heavy) | **Sydney** (+ Singapore, Mumbai) | Anti-DDoS culture; EU strength. Worth later if EU parties matter. |
| **AWS Lightsail / EC2**, **GCP**, **Azure** | Best true global coverage | Sydney and many others | Maximum geo reach, heavier UX/billing for casual BYO. Better as “advanced / bring your cloud” than default. |
| **Hetzner** | EU (+ limited elsewhere; Singapore exists) | **No Australia DC** | Excellent €/perf for EU — **wrong default for AU latency**. Keep as EU-biased option later, never as only provider. |
| **Contabo** etc. | Fewer regions | Sydney in some plans | Possible cost overflow later; not first pick for API polish / spin-up UX. |

#### Recommendation (working)

1. **Guided provider: Vultr** — coverage + API quality; host already validated the API in prior use. Easy winner for v1 Cloud.
2. **Connect-your-account model (BYO)** — PlayOn never bills for VPS hours; the host’s Vultr account pays Vultr. PlayOn only orchestrates create/destroy/region pick.
3. **Abstract behind a small provider interface** (`listRegions`, `createInstance`, `destroyInstance`, `getStatus`) so another provider can follow later without rewriting placement UX.
4. **Always probe before create:** RTT-sorted regions; **hide or warn** high-latency picks (no silent US box for AU).
5. **Hetzner** stays EU-biased later — never the global default.

#### Connect Vultr account (OAuth from day one)

**Decision:** skip API-key paste as the product path. Do **Connect Vultr** properly via Vultr’s OAuth 2.0 app flow from the start.

Happy path:

1. Host signs up / logs into Vultr (their account, their card).
2. PlayOn Settings → Cloud capacity → **Connect Vultr**.
3. Browser consent on Vultr → authorize PlayOn (scoped permissions for compute create/list/destroy, etc.).
4. PlayOn stores **access + refresh tokens** only on the self-hosted control plane (encrypted at rest; never in player panel / logs).
5. Cloud placement works: create server → Cloud → list nearby regions → spin tagged instance on their account → node-agent + tunnel.
6. **Disconnect** in PlayOn (and/or revoke the app in Vultr) invalidates the grant; optional “destroy PlayOn-managed instances” cleanup.

Product story:

> Sign up to Vultr → Connect Vultr once → Cloud placement scales on **your** account when local/remote isn’t enough.

##### How Vultr OAuth fits

Vultr supports third-party OAuth apps (authorization code + PKCE, scoped RS256 bearer tokens):

- PlayOn (the product) registers **one** OAuth App with Vultr (Draft → review → Active).
- Scopes are IAM policies attached to the app (only ask for what Cloud placement needs — compute lifecycle, not the whole account kitchen sink).
- Access tokens ~1 hour; refresh tokens are single-use (rotate on each refresh; reuse revokes the family) — token store must handle rotation carefully.
- Users can revoke PlayOn from Vultr’s authorized-apps list anytime.

##### Self-hosted redirect problem (the real design work)

OAuth `redirect_uri` must **exactly** match a registered callback, and Active apps want `https://…`. Every PlayOn install has a different LAN URL, so we can’t register thousands of customer callbacks on the Vultr app.

**Chosen pattern:** a small **PlayOn OAuth relay** on the public PlayOn site (e.g. `https://connect.playon.games/vultr/callback` or equivalent on playon.games). We control that surface, so Vultr app registration, HTTPS callbacks, and review submission are straightforward on our end.

1. Local PlayOn starts Connect → opens browser to Vultr authorize with `state` bound to this install.
2. Vultr redirects to the fixed PlayOn relay on our website.
3. Relay hands the one-time code (or exchanged tokens) back to the install via a short-lived channel the install already proved (localhost loopback listener, device link code, or authenticated install handshake).
4. Tokens end up **only** on the customer’s control plane — relay must not keep long-lived credentials.

This is still BYO Vultr billing; the relay is just the OAuth front door for self-hosted instances. Offline/air-gapped installs simply don’t use Cloud connect (Local/Remote still work).

**Not the product path:** pasting a personal API key. (Emergency/dev escape hatch only if ever needed — keep it out of Settings UI.)

Guardrails while connected:

- Tag/label all PlayOn-created instances (`playon-managed`, server id) so destroy/sleep only touches what PlayOn made.
- Show estimated hourly cost before create (from Vultr plan list).
- Cap concurrency / max instance size in PlayOn settings so a runaway agent can’t mint a fleet.
- Health: if the grant is revoked, refresh fails, or Vultr billing fails, Cloud placement errors clearly; Local/Remote keep working.
- Minimal OAuth scopes; reconsent if PlayOn later needs broader permissions.

#### Product rules for region pick

- Auto-recommend: lowest acceptable RTT among regions that have the plan size needed.
- Soft warn if best available RTT is above a game skill hint (e.g. competitive FPS vs chill co-op).
- Show country/city in plain language, not only `syd` / `ap-southeast-2`.
- Remember last good region per install, but re-probe when the host’s public egress changes (travel / different venue).

#### Out of scope for provider choice (for now)

- PlayOn-operated capacity pool (merchant of record) — Vultr BYO is the opposite of that.
- Cheap “random datacenter” resellers with no API region control.
- Promising mainland China coverage (separate regulatory problem).

## Networking: especially for Cloud

```
[Players on LAN] → [Local gateway on install host or LAN helper]
                 → [WireGuard / Tailscale / similar]
                 → [VPS game ports]
```

Constraints:

- **UDP matters** — HTTP-only tunnels are often wrong for games.
- **Don’t over-promise LAN discovery** — player panel join links remain the reliable path.
- Prefer **one overlay per VPS node** with many game ports mapped, not a fragile tunnel per server.
- Local and Remote placements usually need no tunnel; Cloud always needs a clear presence story.
- If the tunnel drops, show “capacity unreachable” on that server — don’t fail silently.

## UX sketch

### Create / ask flow

```
“Spin up a modded Minecraft for 10.”

→ Placement
   ○ Local    — this machine (PlayOn host)
   ○ Remote   — another computer on this network
   ○ Cloud    — nearby VPS (tunneled onto the LAN)

→ If Remote: pick node
→ If Cloud: (Vultr connected?) → pick nearby region / size → spin on their account
→ Agent proceeds with skill + runtime on that node
```

Conversation-native variant:

- Host: “put it on the spare PC” → Remote
- Host: “I don’t have a box for this, use cloud” → Cloud
- Host: silent → agent suggests from resources + game needs, host confirms

If Cloud is chosen but Vultr isn’t connected → inline: “Connect Vultr to unlock cloud capacity” (same Settings flow).

### Per-server chrome

- Badge on each server: `Local` / `Remote · basement-pc` / `Cloud · 18ms`
- Actions: **Move…** (change placement), **Open node**, for Cloud also **Sleep VPS / Destroy VPS** when no servers remain

### Mixed party (the point of per-server)

Example evening — local capacity first, cloud for overflow:

| Server | Placement | Why |
|--------|-----------|-----|
| Voice / small proxy | Local | Cheap, always needed |
| Valheim | Remote · spare desktop | Fits on site hardware |
| Huge modded MC | Cloud | Local/remote already full or too weak |
| Second surprise game | Cloud | Spun up mid-party when someone asks |

One panel, three homes. Cloud is an **elastic overflow valve**, not a requirement to abandon self-hosting.

### Burst / scale-out moment

When local + remote nodes are saturated (CPU/RAM/disk) or the next game won’t fit:

1. Host (or agent) creates the next server with **Cloud** placement — no re-architecture.
2. Optional later: agent prompt — “basement-pc is at 90% RAM; put this on cloud?”
3. When the party winds down, Cloud servers stop and VPS sleeps/destroys; Local/Remote keep the long-lived stuff.

Flexibility without forcing an all-cloud lifestyle.

## Trust, security, and tenancy

- Local / Remote: trusted LAN hardware (existing model).
- Cloud: VPS provider can see disk/network unless extra measures later; call that out in UX.
- Prefer single-tenant VPS per host/party over shared multi-tenant game hosts.
- Snapshots: on move/tear-down, offer “pull world home” so Cloud isn’t the only copy.
- Tunnel/node tokens never appear in player panel payloads.

## Product framing

PlayOn stays **self-hosted control** with optional **borrowed capacity per server**.

> **Every server chooses a home: this PC, a LAN box, or a nearby cloud — same panel either way. Use what you have; burst when you need.**

Not a pivot into “PlayOn Cloud Servers” as the default product. Cloud exists so hybrid parties don’t hit a hard ceiling when the spare box is full.

## Open questions

1. **Default placement** for new servers — Local always, or smart suggest?
2. **One Cloud VPS for many servers vs VPS-per-server** — cost vs isolation.
3. **Moving while live** vs require stop + snapshot (almost certainly stop first for v0).
4. **Control plane on a sleeping laptop** while Cloud servers keep running — who holds the gateway?
5. **Remote with no extra nodes yet** — empty state should push “add a node” or offer Cloud.
6. **Naming in UI** — Local / Remote / Cloud vs This PC / Network / Cloud.
7. **Windows game on Linux VPS** — placement UI must filter incompatible targets; Windows VPS regions are scarce.
8. **Billing** — keep PlayOn out of merchant-of-record as long as possible for Cloud.
9. **RTT probe method** — what works through home NATs (ICMP vs TCP/UDP to a PlayOn probe).
10. **OAuth relay → install handoff** — loopback vs link code vs install pairing (website callback itself is settled: we host it).
11. **Exact Vultr OAuth scopes / IAM policies** needed for Cloud placement (minimum set).
12. **Second provider after Vultr** — only if demand appears; same Connect pattern.

## Suggested phasing (if ever built)

1. **Per-server pin to Local vs existing LAN Remote nodes** — productize the language; no Cloud yet.
2. **Move server between Local and Remote** with snapshot + copy.
3. **Cloud attach** — BYO VPS registered as a node + tunnel you bring (Tailscale/WireGuard).
4. **Connect Vultr (OAuth + relay)** + spin-up — consent flow, token rotation, region list, RTT probe, tagged create/destroy, LAN gateway.
5. Optional second provider later (same Connect pattern if they expose OAuth).

## Success metrics (exploratory)

- % of servers created with an explicit placement (vs accidental default)
- Mix of Local / Remote / Cloud in real parties
- Successful moves between placements without data loss
- Cloud join success via LAN gateway
- VPS hours left running with zero servers (waste)

## Relationship to other docs

- Extends [02 – Architecture](02-system-architecture-overview.md) (node targeting + optional WAN node).
- Extends [05 – Runtime & Node Management](05-runtime-and-node-management.md) (selection, moves, blank nodes).
- Touches [12 – Security](12-security-and-safety-model.md) (Cloud trust boundary).
- Roadmap parking lot: [13](13-extensibility-and-roadmap.md).

## Capture notes (raw intent)

> If a user doesn’t have a spare computer to host servers on, there could be a mode that runs the interface locally so they can ask for servers, but instead of using their hardware it uses a nearby VPS and tunnels the connection so it’s like the server was part of the LAN.

> Refinement: make the option **per server** — **Local** (install machine), **Remote** (another computer on the same network), or **Cloud** (spin up a VPS).

> Refinement: hybrid is the point — use on-site compute when you have it, easily spin cloud for overflow when local isn’t enough.

> Provider note: need worldwide coverage so latency stays low — e.g. no US box for an AU party. Working lean: Vultr (API already trusted), always probe RTT before create.

> Connect flow: OAuth-first “Connect Vultr” (no API-key product path). Fixed relay on playon.games (we host whatever Vultr needs); tokens live on the customer control plane; Vultr bills the host.
