import { describe, expect, it } from "vitest";
import { COMPOSE_CHANNEL_KEY } from "./chat-channels.js";
import { agentMoodFromActivity, listServerAgents } from "./agent-presence.js";

describe("server agent occupants", () => {
  it("gives every server its own occupant and only adds compose while in flight", () => {
    expect(agentMoodFromActivity({ phase: "idle" })).toBe("idle");
    expect(agentMoodFromActivity({ pending: true })).toBe("thinking");
    expect(agentMoodFromActivity({ phase: "tool_start" })).toBe("working");

    const fleet = listServerAgents({
      servers: [{ id: "srv-a" }, { id: "srv-b" }],
      pendingKeys: ["server:srv-a"],
      activityByKey: {
        "server:srv-a": { phase: "tool_start", label: "Stopping Alpha", skill: "monitor" },
        "server:srv-b": { phase: "idle" },
      },
      includeCompose: true,
    });
    expect(fleet.map((row) => [row.key, row.mood])).toEqual([
      ["server:srv-a", "working"],
      ["server:srv-b", "idle"],
      [COMPOSE_CHANNEL_KEY, "thinking"],
    ]);
    expect(fleet.filter((row) => row.mood !== "idle")).toHaveLength(2);
  });
});
