# WSL Phase 2 — Networking & LAN Join Smoke Checklist

Manual smoke test for WSL Phase 2 (networking mode detection + LAN join) on `playon-win-1`.

## Prerequisites

- Windows test host: `playon-win-1` (or any Windows 11 host with WSL2)
- PlayOn Home running (can be on the same Windows host or on a separate Linux host)
- At least one LAN client device to test join from (another PC, phone, or tablet on the same network)

## Smoke Test Steps

### 1. Verify WSL Linux Runtime Installed

- [ ] Open Settings → Nodes in PlayOn Home
- [ ] Find the Windows node row (e.g., `local` or node name for `playon-win-1`)
- [ ] Confirm "Linux (WSL)" status chip shows "live" (green)
- [ ] Confirm WSL sibling node `local-wsl` (or `{nodeId}-wsl`) appears in node list with status "online"

### 2. Check Networking Mode Detection

- [ ] On the Windows host, open PowerShell as Administrator
- [ ] Run: `wsl --status` (verify WSL2 is running)
- [ ] Check `.wslconfig` file at `%USERPROFILE%\.wslconfig`
  - If `[wsl2]` section has `networkingMode=mirrored`: **Mirrored mode** (Win11 22H2+)
  - Otherwise: **NAT mode** (default)
- [ ] Note the detected mode for comparison with PlayOn detection

### 3. Create a Server on WSL Node

- [ ] In PlayOn Home, navigate to Map
- [ ] Click "+ Create" and select a Linux Docker skill (e.g., `fixtures.lab-docker-server` or `games.minecraft-java`)
- [ ] Name the server (e.g., "WSL Test Server")
- [ ] Confirm the server is placed on the WSL sibling node (`local-wsl` or `{nodeId}-wsl`)
- [ ] Start the server
- [ ] Wait for status to show "running"

### 4. Verify Join Host Resolution

- [ ] In PlayOn Home, go to Dashboard for the test server
- [ ] Find the join information panel (shows address and port)
- [ ] Verify the join address matches:
  - **Windows host's LAN IP** (e.g., `192.168.1.100`)
  - **NOT** `127.0.0.1` or a WSL-internal IP (e.g., `172.x.x.x`)
- [ ] Copy the join address

### 5. LAN Join Test from Another Device

- [ ] On a separate LAN client device (another PC, phone, tablet)
- [ ] Open the game client corresponding to your test server
- [ ] Use the copied join address (Windows host IP + port)
- [ ] Attempt to connect to the server
- [ ] Verify:
  - [ ] **Mirrored mode:** Connection should succeed (WSL `-p 0.0.0.0` is on the parent NIC)
  - [ ] **NAT mode:** Connection should succeed after start — the Windows node-agent publishes `join_host:port` → `127.0.0.1:port` (`net_port_publish`). Do not run `netsh` portproxy.

### 6. Parent publish check (NAT)

If the advertised Windows LAN IP was closed before start and open after:

- [ ] Windows node agent version advertises `net_port_publish` (Update the Windows node from Settings → Nodes if placement skipped WSL)
- [ ] Home ready-gate / `servers_start` `ready=true` only when that advertised host:port answers
- [ ] Placement skipped WSL (`wsl_lan_publish_unavailable`) and used local docker if the parent agent is too old

### 7. Settings UI Warning Check

- [ ] Open Settings → Nodes in PlayOn Home
- [ ] If WSL is in NAT mode, verify:
  - [ ] A networking warning is displayed in the WSL panel (mentions mirrored vs NAT)
  - [ ] Warning does not tell the host to run `netsh`

### 8. Cleanup

- [ ] Stop and delete the test server (stop releases `net_port_publish` mappings)

## Expected Results

✅ **Pass Criteria:**
- WSL sibling node shows online and can run servers
- Join host resolves to Windows host's LAN IP (not localhost or WSL internal IP)
- After start, that LAN IP:port is open from Home (or placement used a reachable non-WSL node)
- Agent/UI never claims up unless `ready=true`
- Settings UI displays networking mode information

❌ **Fail Criteria:**
- Join host resolves to `127.0.0.1` or WSL internal IP
- LAN clients cannot reach the advertised address and the agent still said the server was up
- Placement picked WSL when the parent cannot publish

## Notes

- **Mirrored networking** (Win11 22H2+) exposes WSL published ports on the parent NIC
- **NAT mode** uses PlayOn `net_port_publish` on the Windows parent (LAN `join_host` → `127.0.0.1`). Update the Windows node agent. Do not ask the host for `netsh` portproxy.

## Automated join-path canary

Address resolution (Linux fixture, WSL parent `join_host`, Windows node `join_host`) plus a TCP “loopback open / join host closed” fail is covered by `pnpm lab:join-path-canary` ([#843](https://github.com/gmcclelland90/playon/issues/843)). Full client join from another LAN device remains this checklist. Never use friend servers as the canary.

## Additional Resources

- [WSL networking documentation](https://learn.microsoft.com/en-us/windows/wsl/networking)
