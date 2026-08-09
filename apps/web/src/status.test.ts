import { describe, expect, it } from "vitest";
import {
  isPendingNodeSetup,
  nodePresenceHint,
  nodePresenceLabel,
  runtimeErrorHint,
  shortDisplayName,
  statusHint,
  statusLabel,
} from "./status";

describe("status helpers", () => {
  it("labels docker_unavailable", () => {
    expect(statusLabel("docker_unavailable")).toBe("Docker missing");
    expect(statusHint("docker_unavailable")).toMatch(/Install Docker/);
  });

  it("maps docker error messages", () => {
    expect(runtimeErrorHint("docker_unavailable")).toMatch(/Settings → Nodes/);
    expect(runtimeErrorHint("Error: no_container_image: skill x")).toMatch(/container image/);
    expect(runtimeErrorHint("something else")).toBeNull();
  });

  it("maps placement / OS mismatch failures", () => {
    expect(runtimeErrorHint("no_eligible_node: os_mismatch:windows")).toMatch(/Linux/);
    expect(runtimeErrorHint("node_ineligible: local (os_mismatch:windows)")).toMatch(
      /Settings → Nodes/,
    );
  });

  it("maps node_token_unset", () => {
    expect(runtimeErrorHint("node_token_unset")).toMatch(/PLAYON_NODE_TOKEN/);
  });

  it("maps ssh add-node failures", () => {
    expect(runtimeErrorHint("ssh_auth_failed")).toMatch(/SSH login failed/);
    expect(
      runtimeErrorHint("All configured authentication methods failed"),
    ).toMatch(/SSH login failed/);
    expect(
      runtimeErrorHint("ssh_needs_root_or_sudo: exit 1: Permission denied"),
    ).toMatch(/root/);
    expect(runtimeErrorHint("ssh_bootstrap_failed: exit 1: nope")).toMatch(/Remote install/);
  });

  it("hints when local node is offline", () => {
    expect(nodePresenceHint({ id: "local", status: "offline" })).toMatch(/playon-node/);
    expect(nodePresenceHint({ id: "spare-1", status: "offline" })).toMatch(/heartbeat/);
    expect(nodePresenceHint({ id: "local", status: "online" })).toBeNull();
  });

  it("labels pending setup for never-bootstrapped nodes", () => {
    expect(isPendingNodeSetup({ agentVersion: "pending", status: "offline" })).toBe(true);
    expect(isPendingNodeSetup({ agentVersion: "pending", status: "online" })).toBe(true);
    expect(nodePresenceLabel({ agentVersion: "pending", status: "online" })).toBe(
      "Pending setup",
    );
    expect(
      nodePresenceHint({ id: "node-x", status: "online", agentVersion: "pending" }),
    ).toMatch(/Bootstrap never finished/);
  });

  it("maps manage scan failures", () => {
    expect(runtimeErrorHint("manage_scan_roots_missing")).toMatch(/import-scan-roots/);
    expect(runtimeErrorHint("manage_cutover_local_unreachable")).toMatch(/Online/);
  });

  it("shortens long display names", () => {
    expect(shortDisplayName("Minecraft Small")).toBe("Minecraft Small");
    expect(shortDisplayName("lab-matrix-stormworks-mslmnas5")).toBe("stormworks");
  });
});
