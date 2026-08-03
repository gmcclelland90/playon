import { describe, expect, it } from "vitest";
import { buildHeartbeat } from "./heartbeat.js";

describe("buildHeartbeat", () => {
  it("reports os and node id", () => {
    const hb = buildHeartbeat({
      nodeId: "local",
      name: "dev-node",
      dataRoot: process.cwd(),
    });
    expect(hb.nodeId).toBe("local");
    expect(["linux", "windows"]).toContain(hb.os);
    expect(typeof hb.docker).toBe("boolean");
    expect(hb.native).toBe(true);
    expect(typeof hb.steamcmd).toBe("boolean");
  });
});

