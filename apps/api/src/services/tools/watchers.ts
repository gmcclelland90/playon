import type { CreateWatcherInput, UpdateWatcherInput, Watcher } from "@playon/shared";
import type { WatcherService } from "../watchers.js";
import { globalTool, optionalServerTool, serverTool, type ToolModule } from "./types.js";
import type { WorkspaceBinding } from "./workspace.js";

type WatcherLookup =
  | { ok: true; watcher: Watcher }
  | { ok: false; error: Record<string, unknown> };

/**
 * Watcher-id tools carry no serverId, so the invoke path cannot enforce the binding:
 * the watcher's own server is what a bound chat is allowed to reach.
 */
async function boundWatcher(
  watchers: WatcherService,
  workspace: WorkspaceBinding,
  watcherId: unknown,
): Promise<WatcherLookup> {
  const watcher = await watchers.get(String(watcherId));
  if (!watcher) return { ok: false, error: { error: "not_found" } };
  if (workspace.serverId && watcher.serverId !== workspace.serverId) {
    return {
      ok: false,
      error: { error: "workspace_server_mismatch", workspaceServerId: workspace.serverId },
    };
  }
  return { ok: true, watcher };
}

const DEFAULT_RUNS_LIMIT = 50;
const DEFAULT_COOLDOWN_MS = 60_000;

/** Watchers: scheduled and event-driven automations plus their run history. */
export const watchersToolModule: ToolModule = ({ plane, workspace }) => {
  const { watchers, watcherEngine } = plane;

  return [
    optionalServerTool({
      def: {
        name: "watchers_list",
        description:
          "List watchers (scheduled/event automations), optionally filtered by serverId.",
        parameters: {
          type: "object",
          properties: { serverId: { type: "string" } },
          additionalProperties: false,
        },
      },
      surface: { skill: "monitor", activityVerb: "run" },
      handler: async (_args, { serverId }) => ({ watchers: await watchers.list(serverId) }),
    }),

    globalTool({
      def: {
        name: "watchers_get",
        description: "Get a watcher by id.",
        parameters: {
          type: "object",
          properties: { watcherId: { type: "string" } },
          required: ["watcherId"],
        },
      },
      surface: { skill: "monitor", activityVerb: "run" },
      handler: async (args) => {
        const found = await boundWatcher(watchers, workspace, args.watcherId);
        return found.ok ? { watcher: found.watcher } : found.error;
      },
    }),

    serverTool({
      def: {
        name: "watchers_create",
        description:
          "Create a watcher. Trigger kinds: schedule, server_status, log_pattern, health, query, panel_input. Actions: tools (allowlisted) or agent (prompt).",
        requiresConfirm: true,
        parameters: {
          type: "object",
          properties: {
            serverId: { type: "string" },
            name: { type: "string" },
            enabled: { type: "boolean" },
            trigger: { type: "object" },
            action: { type: "object" },
            cooldownMs: { type: "number" },
            debounceMs: { type: "number" },
          },
          required: ["serverId", "name", "trigger", "action"],
        },
      },
      surface: {
        skill: "monitor",
        confirmAction: "create a watcher automation",
        activityVerb: "run",
      },
      handler: async (args, { serverId }) => {
        try {
          const watcher = await watchers.create({
            serverId,
            name: String(args.name),
            enabled: args.enabled !== undefined ? Boolean(args.enabled) : true,
            trigger: args.trigger as CreateWatcherInput["trigger"],
            action: args.action as CreateWatcherInput["action"],
            cooldownMs:
              args.cooldownMs !== undefined ? Number(args.cooldownMs) : DEFAULT_COOLDOWN_MS,
            debounceMs: args.debounceMs !== undefined ? Number(args.debounceMs) : 0,
          });
          return { watcher };
        } catch (err) {
          return { error: err instanceof Error ? err.message : "create_failed" };
        }
      },
    }),

    globalTool({
      def: {
        name: "watchers_update",
        description: "Update a watcher by id.",
        requiresConfirm: true,
        parameters: {
          type: "object",
          properties: {
            watcherId: { type: "string" },
            name: { type: "string" },
            enabled: { type: "boolean" },
            trigger: { type: "object" },
            action: { type: "object" },
            cooldownMs: { type: "number" },
            debounceMs: { type: "number" },
          },
          required: ["watcherId"],
        },
      },
      surface: {
        skill: "monitor",
        confirmAction: "update a watcher automation",
        activityVerb: "run",
      },
      handler: async (args) => {
        const found = await boundWatcher(watchers, workspace, args.watcherId);
        if (!found.ok) return found.error;
        try {
          const watcher = await watchers.update(found.watcher.id, {
            name: args.name !== undefined ? String(args.name) : undefined,
            enabled: args.enabled !== undefined ? Boolean(args.enabled) : undefined,
            trigger: args.trigger as UpdateWatcherInput["trigger"] | undefined,
            action: args.action as UpdateWatcherInput["action"] | undefined,
            cooldownMs: args.cooldownMs !== undefined ? Number(args.cooldownMs) : undefined,
            debounceMs: args.debounceMs !== undefined ? Number(args.debounceMs) : undefined,
          });
          return { watcher };
        } catch (err) {
          return { error: err instanceof Error ? err.message : "update_failed" };
        }
      },
    }),

    globalTool({
      def: {
        name: "watchers_delete",
        description: "Delete a watcher by id.",
        requiresConfirm: true,
        parameters: {
          type: "object",
          properties: { watcherId: { type: "string" } },
          required: ["watcherId"],
        },
      },
      surface: {
        skill: "monitor",
        confirmAction: "delete a watcher automation",
        activityVerb: "run",
      },
      handler: async (args) => {
        const found = await boundWatcher(watchers, workspace, args.watcherId);
        if (!found.ok) return found.error;
        await watchers.delete(found.watcher.id);
        return { ok: true, deleted: found.watcher.id };
      },
    }),

    globalTool({
      def: {
        name: "watchers_enable",
        description: "Enable or disable a watcher.",
        parameters: {
          type: "object",
          properties: {
            watcherId: { type: "string" },
            enabled: { type: "boolean" },
          },
          required: ["watcherId", "enabled"],
        },
      },
      surface: { skill: "monitor", activityVerb: "run" },
      handler: async (args) => {
        const found = await boundWatcher(watchers, workspace, args.watcherId);
        if (!found.ok) return found.error;
        return { watcher: await watchers.setEnabled(found.watcher.id, Boolean(args.enabled)) };
      },
    }),

    globalTool({
      def: {
        name: "watchers_run_now",
        description: "Manually fire a watcher once (bypasses enabled check; still records a run).",
        parameters: {
          type: "object",
          properties: { watcherId: { type: "string" } },
          required: ["watcherId"],
        },
      },
      surface: { skill: "monitor", activityVerb: "run" },
      handler: async (args) => {
        const found = await boundWatcher(watchers, workspace, args.watcherId);
        if (!found.ok) return found.error;
        await watcherEngine.enqueue(found.watcher, { kind: "manual" }, { force: true });
        return { ok: true, watcherId: found.watcher.id, queued: true };
      },
    }),

    globalTool({
      def: {
        name: "watchers_runs_list",
        description: "List recent runs for a watcher.",
        parameters: {
          type: "object",
          properties: {
            watcherId: { type: "string" },
            limit: { type: "number" },
          },
          required: ["watcherId"],
        },
      },
      surface: { skill: "monitor", activityVerb: "run" },
      handler: async (args) => {
        const found = await boundWatcher(watchers, workspace, args.watcherId);
        if (!found.ok) return found.error;
        const limit = args.limit !== undefined ? Number(args.limit) : DEFAULT_RUNS_LIMIT;
        return { runs: await watchers.listRuns(found.watcher.id, limit) };
      },
    }),
  ];
};
