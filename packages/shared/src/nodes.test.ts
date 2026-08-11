import { describe, expect, it } from "vitest";
import { deriveNodePresence, placementBadge, placementFromNodeKind } from "./nodes.js";

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

  it("shows WSL badge for local-wsl node", () => {
    expect(placementBadge({ kind: "local", nodeId: "local-wsl" })).toBe("Local · Linux (WSL)");
    expect(placementBadge({ kind: "local", nodeId: "local" })).toBe("Local");
  });
});
