import { describe, expect, it } from "vitest";
import { deriveNodePresence } from "./nodes.js";

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
