import { describe, expect, it, vi } from "vitest";
import { JOIN_HOST_NOT_REACHABLE, evaluateJoinReady, evaluateJoinPathProbe } from "@playon/shared";
import { rconToolModule } from "./rcon.js";
import type { ToolContext } from "./types.js";

describe("rcon tools join-path gate", () => {
  it("fails fast with join_host_not_reachable instead of connecting", async () => {
    const report = evaluateJoinReady({
      processStatus: "running",
      joinPath: evaluateJoinPathProbe({
        joinHost: "172.16.0.94",
        port: 25565,
        loopbackState: "open",
        joinHostState: "closed",
      }),
      protocol: "tcp",
    });
    const getRconEndpoint = vi.fn(async () => ({
      host: "172.16.0.94",
      port: 25575,
      password: "secret",
    }));
    const ctx = {
      plane: {
        servers: { getRconEndpoint },
        joinReady: { probe: vi.fn(async () => report) },
      },
      workspace: { restrictTargets: false },
      skillRoots: [],
    } as unknown as ToolContext;

    const tools = rconToolModule(ctx);
    const exec = tools.find((t) => t.def.name === "rcon_exec");
    expect(exec).toBeTruthy();
    const result = (await exec!.handler({ serverId: "s1", command: "list" }, { serverId: "s1" })) as {
      error?: string;
      hint?: string;
    };
    expect(result.error).toBe(JOIN_HOST_NOT_REACHABLE);
    expect(result.hint).toMatch(/advertised join address/);
    expect(getRconEndpoint).not.toHaveBeenCalled();
  });
});
