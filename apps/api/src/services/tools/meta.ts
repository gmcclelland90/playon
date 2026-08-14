import { probeUdpListen } from "@playon/runtime";
import { isLocalNodeId, isLoopbackJoinHost, type UdpListenProbe } from "@playon/shared";
import { checkNodeLoopbackTcp } from "../node-loopback-tcp.js";
import { nodeJobService, type NodeJobKind } from "../node-jobs.js";
import { globalTool, optionalServerTool, type ToolModule } from "./types.js";

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

/** Host and node probes. Loopback TCP is scoped to a server/node — never Home soak. */
export const metaToolModule: ToolModule = ({ plane }) => {
  const { net, servers } = plane;

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

    optionalServerTool({
      def: {
        name: "net_port_check",
        description:
          "Check whether a TCP port appears open. For 127.0.0.1/localhost, pass nodeId (or bind the chat to a server) so the check runs on that node — Home localhost is not a remote game server. Non-loopback hosts are probed from Home (LAN/advertised path). UDP: pass protocol=udp and nodeId for a remote listen-table probe.",
        parameters: {
          type: "object",
          properties: {
            host: { type: "string" },
            port: { type: "number" },
            protocol: { type: "string", enum: ["tcp", "udp"] },
            nodeId: { type: "string" },
            serverId: { type: "string" },
          },
          required: ["port"],
        },
      },
      surface: { skill: "monitor", activityVerb: "fetch" },
      handler: async (args, { serverId }) => {
        const protocol = String(args.protocol ?? "tcp").toLowerCase() === "udp" ? "udp" : "tcp";
        if (protocol === "udp") {
          return udpPortCheck({
            port: Number(args.port),
            nodeId: args.nodeId ? String(args.nodeId) : undefined,
            host: args.host ? String(args.host) : undefined,
          });
        }
        const host = args.host ? String(args.host) : "127.0.0.1";
        const port = Number(args.port);
        if (isLoopbackJoinHost(host)) {
          let nodeId = args.nodeId ? String(args.nodeId) : undefined;
          if (!nodeId && serverId) {
            const server = await servers.get(serverId);
            nodeId = server?.nodeId ?? undefined;
          }
          if (!nodeId) {
            return {
              host,
              port,
              protocol: "tcp",
              state: "closed",
              error: "loopback_requires_nodeId",
              hint: "127.0.0.1 on Home is not the game server. Pass nodeId or bind the chat to a server so the check runs on that node.",
            };
          }
          if (isLocalNodeId(nodeId)) {
            const probe = await net.portCheck({ host, port });
            return { ...probe, protocol: "tcp", scope: "home" };
          }
          const loopback = await checkNodeLoopbackTcp(nodeId, port, host);
          return {
            host,
            port,
            protocol: "tcp",
            state: loopback.state,
            scope: loopback.scope,
            ...(loopback.unavailable ? { error: "loopback_node_unavailable" } : {}),
          };
        }
        const probe = await net.portCheck({ host, port });
        return { ...probe, protocol: "tcp", scope: "home" };
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
