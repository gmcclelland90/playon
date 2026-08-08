import { nodeJobService, type NodeJobKind } from "../node-jobs.js";
import { globalTool, type ToolModule } from "./types.js";

const NODE_JOB_TIMEOUT_MS = 20_000;

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
        description: "Check whether a TCP port appears open on a host",
        parameters: {
          type: "object",
          properties: {
            host: { type: "string" },
            port: { type: "number" },
          },
          required: ["port"],
        },
      },
      surface: { skill: "monitor", activityVerb: "fetch" },
      handler: async (args) =>
        net.portCheck({
          host: args.host ? String(args.host) : undefined,
          port: Number(args.port),
        }),
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
