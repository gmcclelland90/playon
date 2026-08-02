import { describe, expect, it } from "vitest";
import { ConfirmService } from "./confirm.js";
import { EventHub } from "./event-hub.js";

describe("ConfirmService", () => {
  it("publishes confirm.required and resolves on approve", async () => {
    const hub = new EventHub();
    let published: { requestId: string; toolName: string; summary: string } | undefined;
    hub.subscribe((e) => {
      if (e.type === "confirm.required") {
        published = { requestId: e.requestId, toolName: e.toolName, summary: e.summary };
      }
    });
    const confirms = new ConfirmService(hub, 5_000);

    const wait = confirms.requestConfirmation({
      toolName: "servers_stop",
      summary: "An agent wants to stop this server.",
      arguments: { serverId: "s1" },
    });

    await new Promise((r) => setTimeout(r, 10));
    expect(published?.requestId).toBeTruthy();
    expect(published?.toolName).toBe("servers_stop");
    expect(published?.summary).toBe("An agent wants to stop this server.");
    expect(confirms.size).toBe(1);
    expect(confirms.resolve(published!.requestId, true)).toBe(true);
    await expect(wait).resolves.toEqual({ requestId: published!.requestId, approved: true });
    expect(confirms.size).toBe(0);
  });

  it("times out as denied", async () => {
    const hub = new EventHub();
    const confirms = new ConfirmService(hub, 20);
    const result = await confirms.requestConfirmation({
      toolName: "servers_stop",
      summary: "stop?",
      arguments: {},
    });
    expect(result.approved).toBe(false);
  });
});
