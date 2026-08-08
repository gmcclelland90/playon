import { globalTool, type ToolModule } from "./types.js";

/**
 * The pool of compute nodes servers can be placed on: ranking candidates for a
 * skill, and enrolling or retiring a node over SSH. Node-scoped, never
 * server-scoped — relocating an existing server lives with the servers domain.
 */
export const nodesToolModule: ToolModule = ({ plane }) => {
  const { placement, addNode } = plane;

  return [
    globalTool({
      def: {
        name: "placement_suggest",
        description:
          "Rank nodes for a skill by OS, Docker, disk, online status, and placement kind (Local / Remote / Cloud). Use before servers_create_from_skill when choosing nodeId.",
        parameters: {
          type: "object",
          properties: { skillName: { type: "string" } },
          required: ["skillName"],
        },
      },
      surface: { skill: "installer", activityVerb: "search" },
      handler: async (args) => placement.plan(String(args.skillName)),
    }),

    globalTool({
      def: {
        name: "nodes_add",
        description:
          "Add a LAN or cloud compute node via SSH. Cloud installs WireGuard so servers can join like LAN. Prefer this over asking the host to hand-install the agent.",
        requiresConfirm: true,
        parameters: {
          type: "object",
          properties: {
            kind: { type: "string", enum: ["lan", "cloud"] },
            host: { type: "string" },
            username: { type: "string" },
            password: { type: "string" },
            privateKey: { type: "string" },
            nodeId: { type: "string" },
            nodeName: { type: "string" },
            port: { type: "number" },
          },
          required: ["kind", "host", "username"],
        },
      },
      surface: {
        skill: "installer",
        confirmAction: "enroll a new compute node over SSH",
        activityVerb: "run",
      },
      handler: async (args) =>
        addNode.addViaSsh({
          kind: String(args.kind) === "cloud" ? "cloud" : "lan",
          host: String(args.host),
          username: String(args.username),
          // SSH credentials stay in the handler payload — never echoed back in the result.
          password: args.password != null ? String(args.password) : undefined,
          privateKey: args.privateKey != null ? String(args.privateKey) : undefined,
          nodeId: args.nodeId != null ? String(args.nodeId) : undefined,
          nodeName: args.nodeName != null ? String(args.nodeName) : undefined,
          port: typeof args.port === "number" ? args.port : undefined,
        }),
    }),

    globalTool({
      def: {
        name: "nodes_remove",
        description:
          "Remove a registered LAN/cloud node. Fails if servers are still bound unless force=true. Tears down WireGuard for cloud nodes.",
        requiresConfirm: true,
        parameters: {
          type: "object",
          properties: {
            nodeId: { type: "string" },
            force: { type: "boolean" },
          },
          required: ["nodeId"],
        },
      },
      surface: {
        skill: "installer",
        confirmAction: "remove a compute node from this deployment",
        activityVerb: "run",
      },
      handler: async (args) =>
        addNode.removeNode(String(args.nodeId), { force: args.force === true }),
    }),
  ];
};
