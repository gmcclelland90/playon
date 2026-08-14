import { afterEach, describe, expect, it } from "vitest";
import { ensureWslLanPublish, releaseWslLanPublish } from "./wsl-lan-publish.js";
import { nodeJobService } from "./node-jobs.js";

afterEach(() => {
  nodeJobService.forgetJobKinds("playon-win-1");
});

describe("ensureWslLanPublish", () => {
  it("no-ops for a non-WSL node", async () => {
    const result = await ensureWslLanPublish({
      serverId: "s1",
      wslNodeId: "playon-dev",
      parentJoinHost: "172.16.0.94",
      ports: [{ port: 25565, protocol: "tcp" }],
    });
    expect(result.reason).toBe("not_wsl");
    expect(result.published).toBe(0);
  });

  it("skips when the Windows parent has not advertised net_port_publish", async () => {
    const result = await ensureWslLanPublish({
      serverId: "s1",
      wslNodeId: "playon-win-1-wsl",
      parentJoinHost: "172.16.0.94",
      ports: [{ port: 25565, protocol: "tcp" }],
    });
    expect(result.reason).toBe("wsl_lan_publish_unavailable");
    expect(nodeJobService.claimNext("playon-win-1")).toBeNull();
  });

  it("enqueues ensure jobs on the Windows parent for game and rcon ports", async () => {
    nodeJobService.advertiseJobKinds("playon-win-1", ["net_port_publish"]);
    const pending = ensureWslLanPublish({
      serverId: "srv-mc",
      wslNodeId: "playon-win-1-wsl",
      parentJoinHost: "172.16.0.94",
      ports: [
        { port: 25565, protocol: "tcp" },
        { port: 25575, protocol: "tcp" },
      ],
    });

    const seen: Array<{ listenHost?: string; listenPort?: number; targetHost?: string }> = [];
    for (let i = 0; i < 2; i++) {
      const started = Date.now();
      let job = nodeJobService.claimNext("playon-win-1");
      while (!job && Date.now() - started < 2_000) {
        await new Promise((r) => setTimeout(r, 15));
        job = nodeJobService.claimNext("playon-win-1");
      }
      expect(job?.kind).toBe("net_port_publish");
      const args = job!.args as {
        action: string;
        listenHost: string;
        listenPort: number;
        targetHost: string;
      };
      expect(args.action).toBe("ensure");
      expect(args.listenHost).toBe("172.16.0.94");
      expect(args.targetHost).toBe("127.0.0.1");
      seen.push(args);
      nodeJobService.complete(job!.id, {
        ok: true,
        listening: true,
        action: "ensure",
        serverId: "srv-mc",
        listenHost: args.listenHost,
        listenPort: args.listenPort,
        protocol: "tcp",
        targetHost: "127.0.0.1",
        targetPort: args.listenPort,
      });
    }

    const result = await pending;
    expect(result.published).toBe(2);
    expect(result.reason).toBe("wsl_lan_published");
    expect(seen.map((s) => s.listenPort).sort()).toEqual([25565, 25575]);
  });

  it("releases mappings on the Windows parent", async () => {
    nodeJobService.advertiseJobKinds("playon-win-1", ["net_port_publish"]);
    const pending = releaseWslLanPublish({
      serverId: "srv-mc",
      wslNodeId: "playon-win-1-wsl",
    });
    const started = Date.now();
    let job = nodeJobService.claimNext("playon-win-1");
    while (!job && Date.now() - started < 2_000) {
      await new Promise((r) => setTimeout(r, 15));
      job = nodeJobService.claimNext("playon-win-1");
    }
    expect(job?.kind).toBe("net_port_publish");
    expect(job?.args).toMatchObject({ action: "release_server", serverId: "srv-mc" });
    nodeJobService.complete(job!.id, {
      ok: true,
      listening: false,
      action: "release_server",
      serverId: "srv-mc",
    });
    await pending;
  });
});
