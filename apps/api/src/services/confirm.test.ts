import { describe, expect, it } from "vitest";
import { ConfirmService } from "./confirm.js";
import { EventHub } from "./event-hub.js";

describe("ConfirmService", () => {
  it("publishes confirm.required and resolves on approve", async () => {
    const hub = new EventHub();
    let requestId = "";
    hub.subscribe((e) => {
      if (e.type === "confirm.required") requestId = e.requestId;
    });
    const confirms = new ConfirmService(hub, 5_000);

    const wait = confirms.requestConfirmation({
      toolName: "servers_stop",
      summary: "stop?",
      arguments: { serverId: "s1" },
    });

    await new Promise((r) => setTimeout(r, 10));
    expect(requestId).toBeTruthy();
    expect(confirms.size).toBe(1);
    expect(confirms.resolve(requestId, true)).toBe(true);
    await expect(wait).resolves.toEqual({ requestId, approved: true });
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
