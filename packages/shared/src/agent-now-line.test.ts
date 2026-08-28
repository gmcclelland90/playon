import { describe, expect, it } from "vitest";
import {
  formatLiveNowLine,
  friendlyNowNoun,
  nowLineForPhase,
  nowLineForTool,
} from "./agent-now-line.js";

describe("friendlyNowNoun", () => {
  it("keeps host and version names", () => {
    expect(friendlyNowNoun("win-1")).toBe("win-1");
    expect(friendlyNowNoun("0.2.12")).toBe("0.2.12");
    expect(friendlyNowNoun("PlayOnNodeAgent")).toBe("PlayOnNodeAgent");
  });

  it("drops ids, paths, and secrets", () => {
    expect(friendlyNowNoun("V1StGXR8_Z5jdHi6B-myT")).toBeUndefined();
    expect(friendlyNowNoun("550e8400-e29b-41d4-a716-446655440000")).toBeUndefined();
    expect(friendlyNowNoun("/var/lib/playon/data")).toBeUndefined();
    expect(friendlyNowNoun("sk-abcdefghijklmnopqrstuv")).toBeUndefined();
  });
});

describe("nowLineForTool", () => {
  it("uses display names, not tool ids", () => {
    expect(nowLineForTool("servers_stop", { name: "PlayOnNodeAgent" })).toBe(
      "Stopping PlayOnNodeAgent",
    );
    expect(nowLineForTool("node_ping", { nodeId: "win-1" })).toBe(
      "Waiting for a heartbeat from win-1",
    );
    expect(
      nowLineForTool("nodes_self_update", { version: "0.2.12", nodeName: "win-1" }),
    ).toBe("Copying 0.2.12 onto win-1");
  });

  it("never echoes the raw tool name", () => {
    expect(nowLineForTool("servers_list")).not.toMatch(/servers_list/);
    expect(nowLineForTool("weird_custom_tool")).toBe("Working…");
  });

  it("falls back without args", () => {
    expect(nowLineForTool("servers_stop")).toBe("Stopping the server");
    expect(nowLineForPhase("thinking")).toBe("Thinking…");
    expect(nowLineForPhase("confirm_wait")).toBe("Waiting for confirm…");
    expect(nowLineForPhase("idle")).toBe("Done");
  });
});

describe("formatLiveNowLine", () => {
  it("holds the label for the first couple of seconds", () => {
    expect(formatLiveNowLine("Stopping the server", 800)).toBe("Stopping the server");
  });

  it("appends elapsed once the wait lasts", () => {
    expect(formatLiveNowLine("Waiting for a heartbeat", 4500)).toBe(
      "Waiting for a heartbeat · 4s",
    );
  });
});
