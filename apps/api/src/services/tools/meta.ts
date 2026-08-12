import { probeUdpListen } from "@playon/runtime";
import type { UdpListenProbe } from "@playon/shared";
import { nodeJobService, type NodeJobKind } from "../node-jobs.js";
import { globalTool, type ToolModule } from "./types.js";

const NODE_JOB_TIMEOUT_MS = 20_000;

type UdpPortCheckResult = {
  host: string;
  port: number;
  protocol: "udp";
  state: "open" | "closed";
  listening: boolean;
  probe: UdpListenProbe;
};

function udpCheckResult(
  host: string,
  probed: { port: number; listening: boolean; probe: UdpListenProbe },
): UdpPortCheckResult {
  return {
    host,
    port: probed.port,
    protocol: "udp",
    state: probed.listening ? "open" : "closed",
    listening: probed.listening,
    probe: probed.probe,
  };
}

/**
 * UDP cannot use Home TCP connect. Probe the node's listen table; if the agent
 * is too old or the probe is missing, report unavailable (closed) — never "open".
 */
async function udpPortCheck(args: {
  port: number;
  nodeId?: string;
  host?: string;
}): Promise<UdpPortCheckResult> {
  const port = args.port;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("invalid_port");
  }
  if (args.nodeId) {
    try {
      const job = nodeJobService.enqueue(args.nodeId, "net_udp_listen", { port });
      const done = await nodeJobService.waitFor(job.id, { timeoutMs: NODE_JOB_TIMEOUT_MS });
      if (done.status === "failed" || !done.result || typeof done.result !== "object") {
        return udpCheckResult(args.nodeId, { port, listening: false, probe: "unavailable" });
      }
      const result = done.result as {
        port: number;
        listening: boolean;
        probe: UdpListenProbe;
      };
      return udpCheckResult(args.nodeId, result);
    } catch {
      return udpCheckResult(args.nodeId, { port, listening: false, probe: "unavailable" });
    }
  }
  return udpCheckResult(args.host?.trim() || "127.0.0.1", probeUdpListen(port));
}

/** Enqueue a node job and fold both failure shapes into one tool result. */
async function runNodeJob(
  nodeId: string,
  kind: NodeJobKind,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const job = nodeJobService.enqueue(nodeId, kind, args);
  try {
    const done = await nodeJobService.waitFor(job.id, { timeoutMs: NODE_JOB_TIMEOUT_MS });
    if (done.status === "failed") {
      return { error: done.error ?? "node_job_failed", jobId: job.id };
    }
    return { jobId: job.id, nodeId, result: done.result };
  } catch (err) {
    return { error: err instanceof Error ? err.message : "node_job_timeout", jobId: job.id };
  }
}

/** Host and node probes: no server workspace, no side effects on managed servers. */
export const metaToolModule: ToolModule = ({ plane }) => {
  const { net } = plane;

  return [
    globalTool({
      def: {
        name: "node_ping",
        description:
          "Enqueue a ping job on a node-agent and wait for the result (proves remote job execution).",
        parameters: {
          type: "object",
          properties: { nodeId: { type: "string" } },
          required: ["nodeId"],
        },
      },
      surface: { skill: "installer", activityVerb: "run" },
      handler: async (args) => runNodeJob(String(args.nodeId), "ping", {}),
    }),

    globalTool({
      def: {
        name: "node_fs_list",
        description:
          "List a directory on a node-agent under its data root (path-jailed remote FS).",
        parameters: {
          type: "object",
          properties: {
            nodeId: { type: "string" },
            path: { type: "string" },
          },
          required: ["nodeId"],
        },
      },
      surface: { skill: "installer", activityVerb: "read" },
      handler: async (args) =>
        runNodeJob(String(args.nodeId), "fs_list", {
          path: args.path ? String(args.path) : ".",
        }),
    }),

    globalTool({
      def: {
        name: "net_port_check",
        description:
          "Check whether a TCP port appears open on a host, or whether a UDP port is bound on a node (pass protocol=udp and nodeId for remote Windows/Linux agents)",
        parameters: {
          type: "object",
          properties: {
            host: { type: "string" },
            port: { type: "number" },
            protocol: { type: "string", enum: ["tcp", "udp"] },
            nodeId: { type: "string" },
          },
          required: ["port"],
        },
      },
      surface: { skill: "monitor", activityVerb: "fetch" },
      handler: async (args) => {
        const protocol = String(args.protocol ?? "tcp").toLowerCase() === "udp" ? "udp" : "tcp";
        if (protocol === "udp") {
          return udpPortCheck({
            port: Number(args.port),
            nodeId: args.nodeId ? String(args.nodeId) : undefined,
            host: args.host ? String(args.host) : undefined,
          });
        }
        return net.portCheck({
          host: args.host ? String(args.host) : undefined,
          port: Number(args.port),
        });
      },
    }),

    globalTool({
      def: {
        name: "net_suggest_bind",
        description: "Suggest a free local bind port near a preferred value",
        parameters: {
          type: "object",
          properties: {
            preferredPort: { type: "number" },
            host: { type: "string" },
          },
        },
      },
      surface: { skill: "installer", activityVerb: "fetch" },
      handler: async (args) =>
        net.suggestBind({
          preferredPort: args.preferredPort !== undefined ? Number(args.preferredPort) : undefined,
          host: args.host ? String(args.host) : undefined,
        }),
    }),
  ];
};
