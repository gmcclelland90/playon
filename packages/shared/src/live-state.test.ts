import { describe, expect, it } from "vitest";
import { LiveServerStateSchema, offlineState } from "./live-state.js";

describe("LiveServerStateSchema", () => {
  it("accepts a minimal online result", () => {
    const parsed = LiveServerStateSchema.parse({
      online: true,
      players: 2,
      maxPlayers: 20,
      map: "world",
    });
    expect(parsed.online).toBe(true);
    expect(parsed.players).toBe(2);
  });

  it("accepts playerList and extras", () => {
    const parsed = LiveServerStateSchema.parse({
      online: true,
      playerList: [{ name: "alice", score: 10, time: 120 }],
      extras: { rounds: 3 },
    });
    expect(parsed.playerList?.[0]?.name).toBe("alice");
    expect(parsed.extras?.rounds).toBe(3);
  });

  it("offlineState helper", () => {
    const state = offlineState("timeout", 12);
    expect(state).toEqual({ online: false, queryMs: 12, error: "timeout" });
    expect(LiveServerStateSchema.parse(state).online).toBe(false);
  });
});
