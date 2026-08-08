import { withSnapshot } from "../snapshots.js";
import { globalTool, optionalServerTool, serverTool, type ToolModule } from "./types.js";

const DEFAULT_RETENTION_MAX_COUNT = 10;
const DEFAULT_RETENTION_MAX_AGE_HOURS = 72;

/** Snapshots on the server's own node plus their off-node (USB/NAS/second disk) copies. */
export const snapshotsToolModule: ToolModule = ({ plane, workspace }) => {
  const { snapshots, offNode } = plane;

  return [
    serverTool({
      def: {
        name: "snapshot_create",
        description: "Create a snapshot of a server data directory",
        parameters: {
          type: "object",
          properties: {
            serverId: { type: "string" },
            label: { type: "string" },
          },
          required: ["serverId"],
        },
      },
      surface: { skill: "backup", activityVerb: "snapshot" },
      handler: async (args, { serverId }) => {
        const label = args.label ? String(args.label) : `snapshot-${Date.now()}`;
        const snapshot = await snapshots.create(serverId, label);
        return { snapshotId: snapshot.id, label: snapshot.label, path: snapshot.path };
      },
    }),

    globalTool({
      // Carries no serverId, so the invoke path cannot enforce the binding:
      // the snapshot's own server is what a bound chat is allowed to restore.
      def: {
        name: "snapshot_restore",
        description: "Restore a server from a snapshot",
        requiresConfirm: true,
        parameters: {
          type: "object",
          properties: { snapshotId: { type: "string" } },
          required: ["snapshotId"],
        },
      },
      surface: {
        skill: "backup",
        confirmAction: "restore this server from a snapshot",
        activityVerb: "snapshot",
        xp: { xp: 40, reason: "recovery", celebrate: true },
      },
      handler: async (args) => {
        const snapshotId = String(args.snapshotId);
        const snapshot = await snapshots.get(snapshotId);
        if (!snapshot) throw new Error(`unknown_snapshot: ${snapshotId}`);
        if (workspace.serverId && snapshot.serverId !== workspace.serverId) {
          return {
            error: "workspace_server_mismatch",
            workspaceServerId: workspace.serverId,
            requestedServerId: snapshot.serverId,
          };
        }

        const server = await withSnapshot(snapshots, snapshot.serverId, "pre-restore", async () =>
          snapshots.restore(snapshotId),
        );
        return { serverId: server.id, status: server.status, restoredFrom: snapshotId };
      },
    }),

    optionalServerTool({
      def: {
        name: "snapshot_list",
        description: "List snapshots, optionally filtered by server",
        parameters: {
          type: "object",
          properties: { serverId: { type: "string" } },
        },
      },
      surface: { skill: "backup", activityVerb: "snapshot" },
      handler: async (_args, { serverId }) => {
        const rows = await snapshots.list(serverId);
        return rows.map((s) => ({
          id: s.id,
          serverId: s.serverId,
          label: s.label,
          createdAt: s.createdAt.toISOString(),
        }));
      },
    }),

    optionalServerTool({
      def: {
        name: "snapshot_enforce_retention",
        description:
          "Prune quick/scheduled snapshots by count/age. Durable labels (baseline/backup) are kept.",
        parameters: {
          type: "object",
          properties: {
            serverId: { type: "string" },
            maxCount: { type: "number" },
            maxAgeHours: { type: "number" },
          },
        },
      },
      surface: { skill: "backup", activityVerb: "snapshot" },
      handler: async (args, { serverId }) =>
        snapshots.enforceRetention(serverId, {
          maxCount:
            args.maxCount !== undefined ? Number(args.maxCount) : DEFAULT_RETENTION_MAX_COUNT,
          maxAgeHours:
            args.maxAgeHours !== undefined
              ? Number(args.maxAgeHours)
              : DEFAULT_RETENTION_MAX_AGE_HOURS,
        }),
    }),

    serverTool({
      def: {
        name: "backup_offnode",
        description:
          "Create a durable snapshot and copy it to the configured off-node backup root (USB/NAS/second disk).",
        parameters: {
          type: "object",
          properties: {
            serverId: { type: "string" },
            label: { type: "string" },
          },
          required: ["serverId"],
        },
      },
      surface: {
        skill: "backup",
        activityVerb: "snapshot",
        xp: { xp: 20, reason: "durable_backup" },
      },
      handler: async (args, { serverId }) =>
        offNode.backupServer(serverId, args.label ? String(args.label) : undefined),
    }),

    optionalServerTool({
      def: {
        name: "backup_offnode_list",
        description: "List off-node backups under the configured external target",
        parameters: {
          type: "object",
          properties: { serverId: { type: "string" } },
        },
      },
      surface: { skill: "backup", activityVerb: "snapshot" },
      handler: async (_args, { serverId }) => offNode.list(serverId),
    }),

    optionalServerTool({
      def: {
        name: "backup_offnode_restore",
        description: "Restore a server from an off-node backup export",
        requiresConfirm: true,
        parameters: {
          type: "object",
          properties: {
            backupId: { type: "string" },
            serverId: { type: "string" },
          },
          required: ["backupId"],
        },
      },
      surface: {
        skill: "backup",
        confirmAction: "restore this server from an off-site backup",
        activityVerb: "snapshot",
        xp: { xp: 45, reason: "recovery_offnode", celebrate: true },
      },
      handler: async (args, { serverId }) => offNode.restore(String(args.backupId), serverId),
    }),
  ];
};
