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

  it("rejects unknown event types", () => {
    expect(() => WsEventSchema.parse({ type: "nope" })).toThrow();
  });
});
