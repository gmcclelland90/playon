import { afterEach, describe, expect, it, vi } from "vitest";
import { NodeHeartbeatSchema } from "@playon/shared";
import { buildHeartbeat, postHeartbeat } from "./heartbeat.js";
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

  it("includes a read-only engine inventory when the list succeeds", async () => {
    const hb = await buildHeartbeat({
      nodeId: "playon-win-1",
      name: "win-1",
      dataRoot: process.cwd(),
      listContainers: async () => [
        {
          name: "lab-sbox",
          image: "har0x/sbox-server:public",
          status: "running",
          ports: [{ host: 27150, container: 27150, protocol: "tcp" }],
        },
      ],
    });
    expect(hb.containers).toEqual([
      {
        name: "lab-sbox",
        image: "har0x/sbox-server:public",
        status: "running",
        ports: [{ host: 27150, container: 27150, protocol: "tcp" }],
      },
    ]);
    expect(NodeHeartbeatSchema.parse(hb).containers?.[0]?.name).toBe("lab-sbox");
  });

  it("includes host RAM (CPU only after ticks advance)", async () => {
    const hb = await buildHeartbeat({
      nodeId: "local",
      name: "dev-node",
      dataRoot: process.cwd(),
      listContainers: async () => [],
      listProcesses: () => [],
    });
    expect(hb.memUsedBytes).toBeGreaterThan(0);
    expect(hb.memTotalBytes).toBeGreaterThan(0);
    expect(NodeHeartbeatSchema.parse(hb).memTotalBytes).toBe(hb.memTotalBytes);
    if (hb.cpuPercent != null) {
      expect(hb.cpuPercent).toBeGreaterThanOrEqual(0);
      expect(hb.cpuPercent).toBeLessThanOrEqual(100);
    }
  });
});

describe("postHeartbeat", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reads restartRequested from the heartbeat ACK", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ ok: true, status: "online", restartRequested: true }),
      })),
    );
    const ack = await postHeartbeat(
      "http://home:8787",
      {
        nodeId: "playon-win-1",
        name: "playon-win-1",
        os: "windows",
        docker: false,
        native: true,
        steamcmd: false,
        agentVersion: "0.2.13",
      },
      "tok",
    );
    expect(ack).toEqual({ ok: true, status: "online", restartRequested: true });
  });
});

