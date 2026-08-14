import { afterEach, describe, expect, it } from "vitest";
import { checkServerLoopbackTcp } from "./node-loopback-tcp.js";
import { nodeJobService } from "./node-jobs.js";

afterEach(() => {
  nodeJobService.forgetJobKinds("playon-win-1-wsl");
});

describe("checkServerLoopbackTcp", () => {
  it("uses Home for the local node", async () => {
    const probe = await checkServerLoopbackTcp("local", 25565, async () => "open");
    expect(probe).toEqual({ state: "open", scope: "home", unavailable: false });
  });

  it("does not fall back to Home when a remote node has not advertised net_tcp_connect", async () => {
    const probe = await checkServerLoopbackTcp("playon-win-1-wsl", 25565, async () => "open");
    expect(probe.state).toBe("closed");
    expect(probe.scope).toBe("node");
    expect(probe.unavailable).toBe(true);
  });

  it("returns the node job result when advertised", async () => {
    nodeJobService.advertiseJobKinds("playon-win-1-wsl", ["net_tcp_connect"]);
    const pending = checkServerLoopbackTcp("playon-win-1-wsl", 25565, async () => "open");
    const started = Date.now();
    let job = nodeJobService.claimNext("playon-win-1-wsl");
    while (!job && Date.now() - started < 2_000) {
      await new Promise((r) => setTimeout(r, 20));
      job = nodeJobService.claimNext("playon-win-1-wsl");
    }
    expect(job?.kind).toBe("net_tcp_connect");
    nodeJobService.complete(job!.id, { host: "127.0.0.1", port: 25565, state: "open" });
    const probe = await pending;
    expect(probe).toEqual({ state: "open", scope: "node", unavailable: false });
  });
});
