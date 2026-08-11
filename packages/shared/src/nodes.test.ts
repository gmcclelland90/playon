import { describe, expect, it } from "vitest";
import {
  deriveNodePresence,
  isWslNodeId,
  placementBadge,
  placementFromNodeKind,
  wslParentNodeId,
  wslSiblingNodeId,
} from "./nodes.js";

describe("deriveNodePresence", () => {
  const now = 1_000_000;

  it("marks recent heartbeats online", () => {
    expect(deriveNodePresence(now - 5_000, now)).toBe("online");
  });

  it("marks mid-age heartbeats stale", () => {
    expect(deriveNodePresence(now - 30_000, now)).toBe("stale");
  });

  it("marks old heartbeats offline", () => {
    expect(deriveNodePresence(now - 120_000, now)).toBe("offline");
  });
});

describe("placement helpers", () => {
  it("maps node kinds to placement", () => {
    expect(placementFromNodeKind("local")).toBe("local");
    expect(placementFromNodeKind("lan")).toBe("remote");
    expect(placementFromNodeKind("cloud")).toBe("cloud");
  });

  it("formats badges", () => {
    expect(placementBadge({ kind: "local" })).toBe("Local");
    expect(placementBadge({ kind: "lan", name: "basement" })).toBe("Remote · basement");
    expect(placementBadge({ kind: "cloud", name: "vps-1", rttMs: 18 })).toBe("Cloud · vps-1 · 18ms");
  });

  it("shows WSL badge for local-wsl and remote sibling ids", () => {
    expect(placementBadge({ kind: "local", nodeId: "local-wsl" })).toBe("Local · Linux (WSL)");
    expect(placementBadge({ kind: "lan", nodeId: "win-1-wsl" })).toBe("Remote · Linux (WSL)");
    expect(placementBadge({ kind: "local", nodeId: "local" })).toBe("Local");
  });
});

describe("wsl sibling ids", () => {
  it("maps local and remote Windows nodes", () => {
    expect(wslSiblingNodeId("local")).toBe("local-wsl");
    expect(wslSiblingNodeId("win-1")).toBe("win-1-wsl");
    expect(isWslNodeId("local-wsl")).toBe(true);
    expect(isWslNodeId("win-1-wsl")).toBe(true);
    expect(isWslNodeId("win-1")).toBe(false);
    expect(wslParentNodeId("local-wsl")).toBe("local");
    expect(wslParentNodeId("win-1-wsl")).toBe("win-1");
  });
});
