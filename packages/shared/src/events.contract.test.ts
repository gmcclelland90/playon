import { describe, expect, it } from "vitest";
import { WsEventSchema } from "./events.js";

describe("WsEventSchema", () => {
  it("accepts server.log, server.status, and confirm.required events", () => {
    expect(
      WsEventSchema.parse({ type: "server.log", serverId: "abc", line: "hello" }),
    ).toMatchObject({ type: "server.log" });
    expect(
      WsEventSchema.parse({ type: "server.status", serverId: "abc", status: "starting" }),
    ).toMatchObject({ status: "starting" });
    expect(
      WsEventSchema.parse({
        type: "confirm.required",
        requestId: "req-1",
        toolName: "servers_stop",
        summary: "An agent wants to stop this server.",
      }),
    ).toMatchObject({ type: "confirm.required" });
    expect(
      WsEventSchema.parse({
        type: "chat.token",
        conversationId: "c1",
        token: "Hello",
      }),
    ).toMatchObject({ type: "chat.token" });
    expect(
      WsEventSchema.parse({
        type: "chat.tool",
        conversationId: "c1",
        toolName: "servers_list",
        status: "started",
      }),
    ).toMatchObject({ type: "chat.tool" });
  });

  it("accepts update.progress", () => {
    expect(
      WsEventSchema.parse({
        type: "update.progress",
        target: "home",
        phase: "downloading",
        message: "Downloading update…",
        percent: 20,
      }),
    ).toMatchObject({ type: "update.progress", target: "home" });
  });

  it("accepts node.metrics with optional cpu/mem/disk", () => {
    expect(
      WsEventSchema.parse({
        type: "node.metrics",
        nodeId: "local",
        metrics: { cpuPercent: 14, memUsedBytes: 1, memTotalBytes: 2, freeDiskBytes: 3 },
      }),
    ).toMatchObject({ type: "node.metrics", nodeId: "local" });
  });

  it("accepts agent.activity without a serverId and with thinking", () => {
    expect(
      WsEventSchema.parse({
        type: "agent.activity",
        conversationId: "c1",
        skill: "orchestrator",
        phase: "tool_start",
        verb: "run",
        label: "Waiting for a heartbeat from win-1",
        thinking: "Looks like win-1 is still on 0.2.10, so I’ll swap from the extracted tar.",
        steps: [{ label: "Waiting for a heartbeat from win-1", status: "active" }],
      }),
    ).toMatchObject({
      type: "agent.activity",
      label: "Waiting for a heartbeat from win-1",
      thinking: expect.stringContaining("win-1"),
    });
  });

  it("still accepts agent.activity with a serverId", () => {
    expect(
      WsEventSchema.parse({
        type: "agent.activity",
        serverId: "srv-1",
        conversationId: "c1",
        skill: "installer",
        phase: "thinking",
        verb: "other",
        label: "Thinking…",
      }),
    ).toMatchObject({ serverId: "srv-1", phase: "thinking" });
  });

  it("rejects unknown event types", () => {
    expect(() => WsEventSchema.parse({ type: "nope" })).toThrow();
  });
});
