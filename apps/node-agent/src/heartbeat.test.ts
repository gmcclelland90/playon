import { describe, expect, it } from "vitest";
import { NodeHeartbeatSchema } from "@playon/shared";
import { buildHeartbeat } from "./heartbeat.js";
import { SUPPORTED_JOB_KINDS } from "./jobs.js";

describe("buildHeartbeat", () => {
  it("reports os and node id", async () => {
    const hb = await buildHeartbeat({
      nodeId: "local",
      name: "dev-node",
      dataRoot: process.cwd(),
      agentVersion: "0.1.4",
    });
    expect(hb.nodeId).toBe("local");
    expect(["linux", "windows"]).toContain(hb.os);
    expect(typeof hb.docker).toBe("boolean");
    expect(hb.native).toBe(true);
    expect(typeof hb.steamcmd).toBe("boolean");
    expect(hb.agentVersion).toBe("0.1.4");
  });

  it("advertises the job kinds this agent can execute", async () => {
    const hb = await buildHeartbeat({ nodeId: "node-z", name: "lab", dataRoot: process.cwd() });
    expect(hb.jobKinds).toEqual([...SUPPORTED_JOB_KINDS]);
    // The control plane parses heartbeats with this schema before trusting them.
    expect(NodeHeartbeatSchema.parse(hb).jobKinds).toEqual([...SUPPORTED_JOB_KINDS]);
  });
});

