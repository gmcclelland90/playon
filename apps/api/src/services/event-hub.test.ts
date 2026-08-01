import { describe, expect, it, vi } from "vitest";
import { EventHub } from "./event-hub.js";

describe("EventHub", () => {
  it("fans out to subscribers and supports unsubscribe", () => {
    const hub = new EventHub();
    const a = vi.fn();
    const b = vi.fn();
    const unsubA = hub.subscribe(a);
    hub.subscribe(b);

    hub.publish({ type: "server.log", serverId: "s1", line: "hello" });
    expect(a).toHaveBeenCalledOnce();
    expect(b).toHaveBeenCalledOnce();

    unsubA();
    hub.publish({ type: "server.status", serverId: "s1", status: "running" });
    expect(a).toHaveBeenCalledOnce();
    expect(b).toHaveBeenCalledTimes(2);
  });
});
