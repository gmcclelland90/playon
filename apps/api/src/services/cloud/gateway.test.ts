import { afterEach, describe, expect, it } from "vitest";
import type { AppConfig } from "../../config.js";
import { LanGateway } from "./gateway.js";

const config = {
  advertiseHost: "192.168.1.10",
  port: 8787,
  dataRoot: "/tmp",
  dbPath: "/tmp/x.db",
  sessionSecret: "x",
  llmMode: "openai_compatible",
  runtimeMode: "native",
  skillsRoots: [],
} satisfies AppConfig;

describe("LanGateway", () => {
  const gw = new LanGateway(config);

  afterEach(async () => {
    await gw.releaseAll();
  });

  it("tracks TCP mappings", async () => {
    const m = await gw.ensure({
      serverId: "s1",
      nodeId: "n1",
      listenPort: 0, // ephemeral — may fail on some hosts; use high port
      protocol: "tcp",
      targetHost: "127.0.0.1",
      targetPort: 9,
    });
    // Re-bind with a fixed high port for reliability
    await gw.releaseAll();
    const m2 = await gw.ensure({
      ...m,
      listenPort: 39111,
    });
    expect(m2.listenPort).toBe(39111);
    expect(gw.list()).toHaveLength(1);
    await gw.releaseServer("s1");
    expect(gw.list()).toHaveLength(0);
  });
});
