import { queryDialectToolEnum } from "@playon/server-query";
import type { QueryDialect } from "@playon/shared";
import { isPlayerPanelLiveStatus, safeQueryLive } from "../server-panel.js";
import { loadSkillMetadata } from "../skills.js";
import { seedWatchersForNewServer } from "../watchers.js";
import { globalTool, serverTool, type ToolModule } from "./types.js";
import { createOrReinstallFromSkill, workspaceCreateForbidden } from "./workspace.js";

const QUERY_DIALECT_TOOL_ENUM = queryDialectToolEnum();

/** Live stats settle a few seconds after a start/restart, so give the query room. */
const POST_START_QUERY = { attempts: 5, delayMs: 1200 };

const DEFAULT_LOG_LINES = 80;

/** Server lifecycle: provision, run, inspect, relocate, adopt, retire. */
export const serversToolModule: ToolModule = ({ plane, workspace, skillRoots }) => {
  const {
    servers,
    snapshots,
    panel,
    playerPanel,
    queries,
    health,
    migrate,
    importLocal,
    importSftp,
    watchers,
  } = plane;

  return [
    globalTool({
      def: {
        name: "servers_create_from_skill",
        description:
          "Create a server from a skill. In a bound server chat (or after the first create this turn), this wipes and reinstalls that same server id — it never creates a sibling.",
        parameters: {
          type: "object",
          properties: {
            skillName: { type: "string" },
            serverName: { type: "string" },
            nodeId: { type: "string" },
          },
          required: ["skillName"],
        },
      },
      surface: {
        skill: "installer",
        activityVerb: "run",
        xp: { xp: 50, reason: "clean_install", celebrate: true },
      },
      handler: async (args) => {
        const skillName = String(args.skillName);
        const { server, mode } = await createOrReinstallFromSkill(servers, workspace, {
          skillName,
          serverName: args.serverName ? String(args.serverName) : undefined,
          nodeId: args.nodeId ? String(args.nodeId) : undefined,
        });
        await snapshots.create(server.id, "baseline");
        await playerPanel.publishForStatus(server.id, "stopped");
        const skill = loadSkillMetadata(skillRoots, skillName);
        // Always seed: skill templates (if any) plus the platform Health monitor
        // when the skill did not declare health+restart. Import/manage do not
        // call this — existing friend servers are not mutated.
        await seedWatchersForNewServer(watchers, {
          serverId: server.id,
          skillSlug: skill?.metadata.name ?? skillName,
          templates: skill?.metadata.watchers,
        });
        const join = await servers.joinInfoFor(server);
        return {
          serverId: server.id,
          name: server.name,
          status: server.status,
          runtimeMode: server.runtimeMode,
          mode,
          join,
        };
      },
    }),

    serverTool({
      def: {
        name: "servers_start",
        description:
          "Start a server. Returns ready=true only when the advertised panel join host:port is reachable (or query succeeded). Process-up or 127.0.0.1 is not enough — never tell the host the server is up unless ready is true.",
        parameters: {
          type: "object",
          properties: { serverId: { type: "string" } },
          required: ["serverId"],
        },
      },
      surface: {
        skill: "installer",
        activityVerb: "run",
        xp: { xp: 15, reason: "server_start" },
      },
      handler: async (_args, { serverId }) => {
        const server = await servers.start(serverId);
        const live = await safeQueryLive(
          (id) => queries.queryServerWithRetry(id, POST_START_QUERY),
          server.id,
        );
        const joinReady = await plane.joinReady.probeWithRetry(server.id, POST_START_QUERY);
        const panelStatus = joinReady.ready ? "running" : joinReady.status;
        await playerPanel.publishForStatus(server.id, panelStatus, live);
        const detail = await servers.detail(server.id);
        return {
          serverId: server.id,
          status: server.status,
          ready: joinReady.ready,
          joinPath: joinReady.joinPath,
          joinReady,
          runtime: detail?.runtime,
          join: detail?.runtime.join,
          panelPublished: true,
          playerVisible: isPlayerPanelLiveStatus(panelStatus),
          liveOnline: live?.online ?? false,
        };
      },
    }),

    serverTool({
      def: {
        name: "servers_stop",
        description: "Stop a server",
        requiresConfirm: true,
        parameters: {
          type: "object",
          properties: { serverId: { type: "string" } },
          required: ["serverId"],
        },
      },
      surface: {
        skill: "installer",
        confirmAction: "stop this server",
        activityVerb: "run",
      },
      handler: async (_args, { serverId }) => {
        const server = await servers.stop(serverId);
        await playerPanel.publishForStatus(server.id, "stopped");
        return { serverId: server.id, status: server.status };
      },
    }),

    serverTool({
      def: {
        name: "servers_restart",
        description: "Restart a server (stop then start)",
        requiresConfirm: true,
        parameters: {
          type: "object",
          properties: { serverId: { type: "string" } },
          required: ["serverId"],
        },
      },
      surface: {
        skill: "troubleshooter",
        confirmAction: "restart this server",
        activityVerb: "run",
        xp: { xp: 12, reason: "server_restart" },
      },
      handler: async (_args, { serverId }) => {
        const server = await servers.restart(serverId);
        const live = await safeQueryLive(
          (id) => queries.queryServerWithRetry(id, POST_START_QUERY),
          server.id,
        );
        const joinReady = await plane.joinReady.probeWithRetry(server.id, POST_START_QUERY);
        const panelStatus = joinReady.ready ? "running" : joinReady.status;
        await playerPanel.publishForStatus(server.id, panelStatus, live);
        const detail = await servers.detail(server.id);
        return {
          serverId: server.id,
          status: server.status,
          ready: joinReady.ready,
          joinPath: joinReady.joinPath,
          joinReady,
          runtime: detail?.runtime,
          join: detail?.runtime.join,
          liveOnline: live?.online ?? false,
        };
      },
    }),

    globalTool({
      def: {
        name: "servers_list",
        description: "List servers",
        parameters: { type: "object", properties: {}, additionalProperties: false },
      },
      surface: { skill: "orchestrator", activityVerb: "run" },
      handler: async () => {
        const rows = await servers.list();
        const scoped = workspace.restrictTargets
          ? workspace.serverId
            ? rows.filter((s) => s.id === workspace.serverId)
            : []
          : rows;
        return scoped.map((s) => {
          const cached = plane.joinReady.cached(s.id);
          return {
            id: s.id,
            name: s.name,
            game: s.game,
            status: s.status,
            ready: cached?.ready,
          };
        });
      },
    }),

    serverTool({
      def: {
        name: "servers_health_check",
        description:
          "Run skill-declared health checks plus the advertised join-path gate. ready=true only when the panel join host:port is reachable. Set remediate=true to auto-restart on known restartable process failures (not join-path publish gaps).",
        parameters: {
          type: "object",
          properties: {
            serverId: { type: "string" },
            remediate: { type: "boolean" },
          },
          required: ["serverId"],
        },
      },
      surface: { skill: "monitor", activityVerb: "run" },
      handler: async (args, { serverId }) =>
        health.checkServer(serverId, { remediate: Boolean(args.remediate) }),
    }),

    serverTool({
      def: {
        name: "servers_relocate",
        description:
          "Move a server onto another node: stop, snapshot, sync server dir, rebind nodeId, restart on the target.",
        requiresConfirm: true,
        parameters: {
          type: "object",
          properties: {
            serverId: { type: "string" },
            targetNodeId: { type: "string" },
          },
          required: ["serverId", "targetNodeId"],
        },
      },
      surface: {
        skill: "installer",
        confirmAction: "move this server to another machine",
        activityVerb: "run",
        xp: { xp: 30, reason: "relocate" },
      },
      handler: async (args, { serverId }) =>
        migrate.relocate(serverId, String(args.targetNodeId)),
    }),

    globalTool({
      def: {
        name: "servers_import_local",
        description:
          "Import an existing server directory from an absolute local path into PlayOn (copy, attach/detect/draft skill, baseline snapshot).",
        requiresConfirm: true,
        parameters: {
          type: "object",
          properties: {
            sourcePath: { type: "string" },
            serverName: { type: "string" },
            skillName: { type: "string" },
            game: { type: "string" },
            nodeId: { type: "string" },
          },
          required: ["sourcePath"],
        },
      },
      surface: {
        skill: "installer",
        confirmAction: "import a server from a local folder",
        activityVerb: "run",
        xp: { xp: 55, reason: "clean_import", celebrate: true },
      },
      handler: async (args) => {
        const blocked = workspaceCreateForbidden(
          workspace.serverId,
          "Deselect the server (install chat) to import another.",
        );
        if (blocked) return blocked;
        const report = await importLocal.importFromPath({
          sourcePath: String(args.sourcePath),
          serverName: args.serverName ? String(args.serverName) : undefined,
          skillName: args.skillName ? String(args.skillName) : undefined,
          game: args.game ? String(args.game) : undefined,
          nodeId: args.nodeId ? String(args.nodeId) : undefined,
        });
        workspace.serverId = report.server.id;
        return {
          serverId: report.server.id,
          name: report.server.name,
          skillName: report.skillName,
          skillSource: report.skillSource,
          baselineSnapshotId: report.baselineSnapshotId,
          followUp: report.followUp,
        };
      },
    }),

    globalTool({
      def: {
        name: "servers_import_sftp",
        description:
          "Pull an existing server directory over SFTP into a staging folder, then run the local import pipeline.",
        requiresConfirm: true,
        parameters: {
          type: "object",
          properties: {
            host: { type: "string" },
            port: { type: "number" },
            username: { type: "string" },
            password: { type: "string" },
            privateKey: { type: "string" },
            remotePath: { type: "string" },
            serverName: { type: "string" },
            skillName: { type: "string" },
            game: { type: "string" },
            nodeId: { type: "string" },
          },
          required: ["host", "username", "remotePath"],
        },
      },
      surface: {
        skill: "installer",
        confirmAction: "import a server over SFTP",
        activityVerb: "run",
        xp: { xp: 60, reason: "clean_import_sftp", celebrate: true },
      },
      handler: async (args) => {
        const blocked = workspaceCreateForbidden(
          workspace.serverId,
          "Deselect the server (install chat) to import another.",
        );
        if (blocked) return blocked;
        const report = await importSftp.importFromSftp({
          host: String(args.host),
          port: args.port !== undefined ? Number(args.port) : undefined,
          username: String(args.username),
          password: args.password ? String(args.password) : undefined,
          privateKey: args.privateKey ? String(args.privateKey) : undefined,
          remotePath: String(args.remotePath),
          serverName: args.serverName ? String(args.serverName) : undefined,
          skillName: args.skillName ? String(args.skillName) : undefined,
          game: args.game ? String(args.game) : undefined,
          nodeId: args.nodeId ? String(args.nodeId) : undefined,
        });
        // Never echo credentials back through the tool trace.
        workspace.serverId = report.server.id;
        return {
          serverId: report.server.id,
          name: report.server.name,
          skillName: report.skillName,
          skillSource: report.skillSource,
          baselineSnapshotId: report.baselineSnapshotId,
          remoteHost: report.remoteHost,
          remotePath: report.remotePath,
          followUp: report.followUp,
        };
      },
    }),

    serverTool({
      def: {
        name: "servers_delete",
        description:
          "Permanently delete a server: stop runtime, remove Docker container, wipe data dir, panel blocks, chats, and snapshots.",
        requiresConfirm: true,
        parameters: {
          type: "object",
          properties: { serverId: { type: "string" } },
          required: ["serverId"],
        },
      },
      surface: {
        skill: "orchestrator",
        confirmAction: "permanently delete this server",
        activityVerb: "run",
      },
      handler: async (_args, { serverId }) => {
        const removed = await servers.remove(serverId);
        await panel.clearForServer(removed.id);
        return { ok: true, removed };
      },
    }),

    serverTool({
      def: {
        name: "servers_logs_tail",
        description:
          "Return the latest runtime log lines for a server (Docker/native adapter). Use after restarts or failed mod loads.",
        parameters: {
          type: "object",
          properties: {
            serverId: { type: "string" },
            lines: { type: "number", description: "Number of lines to return (default 80, max 200)" },
          },
          required: ["serverId"],
        },
      },
      surface: { skill: "troubleshooter", activityVerb: "read" },
      handler: async (args, { serverId }) => {
        const requested = args.lines !== undefined ? Number(args.lines) : DEFAULT_LOG_LINES;
        const lineCount = Number.isFinite(requested) ? requested : DEFAULT_LOG_LINES;
        const result = await servers.tailLogs(serverId, lineCount);
        if (!result) return { error: `unknown_server: ${serverId}` };
        return { serverId, ...result };
      },
    }),

    serverTool({
      def: {
        name: "servers_query",
        description:
          "Query live game stats (players, map, mode, …) for a managed server via its skill queryDialect or skill_module connector.",
        parameters: {
          type: "object",
          properties: { serverId: { type: "string" } },
          required: ["serverId"],
        },
      },
      surface: { skill: "monitor", activityVerb: "run" },
      handler: async (_args, { serverId }) => {
        const state = await queries.queryServer(serverId);
        if (state.online) {
          const server = await servers.get(serverId);
          if (server && (server.status === "running" || server.status === "starting")) {
            try {
              const joinReady = await plane.joinReady.probe(serverId);
              await playerPanel.publishForStatus(
                serverId,
                joinReady.ready
                  ? server.status === "starting"
                    ? "starting"
                    : "running"
                  : joinReady.status,
                state,
              );
            } catch {
              /* panel refresh best-effort */
            }
          }
        }
        return { serverId, ...state };
      },
    }),

    globalTool({
      def: {
        name: "servers_query_test",
        description:
          "Test a query dialect or draft skill_module connector against host:port. Use while authoring connectors.",
        parameters: {
          type: "object",
          properties: {
            host: { type: "string" },
            port: { type: "number" },
            queryPort: { type: "number" },
            gamePort: { type: "number" },
            skillName: { type: "string" },
            connectorPath: { type: "string" },
            queryDialect: {
              type: "string",
              enum: QUERY_DIALECT_TOOL_ENUM,
            },
            timeoutMs: { type: "number" },
          },
          required: ["host", "port"],
        },
      },
      surface: { skill: "troubleshooter", activityVerb: "run" },
      handler: async (args) =>
        queries.queryTest({
          host: String(args.host ?? "127.0.0.1"),
          port: Number(args.port),
          queryPort: args.queryPort !== undefined ? Number(args.queryPort) : undefined,
          gamePort: args.gamePort !== undefined ? Number(args.gamePort) : undefined,
          skillName: args.skillName ? String(args.skillName) : undefined,
          connectorPath: args.connectorPath ? String(args.connectorPath) : undefined,
          queryDialect: args.queryDialect as QueryDialect | undefined,
          timeoutMs: args.timeoutMs !== undefined ? Number(args.timeoutMs) : undefined,
        }),
    }),
  ];
};
