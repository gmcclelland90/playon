import type {
  ChatStreamSink,
  ConfirmGate,
  ConfirmPolicy,
  ToolDefinition,
  ToolEntry,
  ToolHandler,
  ToolSurface,
  ToolSurfaceMeta,
} from "@playon/agent-core";
import {
  createToolSurface,
  Orchestrator,
  OpenAICompatibleLlmClient,
  runToolInvocation,
  TOOL_SURFACE_OVERLAY,
  type LlmClient,
} from "@playon/agent-core";
import {
  getLlmPreset,
  type CreateWatcherInput,
  type UpdateWatcherInput,
} from "@playon/shared";
import type { AppConfig } from "../config.js";
import type { ControlPlane } from "../control-plane.js";
import type { Db } from "../db/client.js";
import { decryptSecret } from "./secrets.js";
import {
  getSetting,
  LLM_SETTINGS_KEY,
  resolveLlmPreset,
  type LlmSettings,
} from "./settings.js";
import { skillsRootsForWorkspace } from "./skills.js";
import { rconExec, rconExecWithSelfHeal } from "./rcon.js";
import { SnapshotService, withSnapshot } from "./snapshots.js";
import { SteamcmdNotFoundError, steamcmdAppUpdate } from "./steamcmd.js";
import { composeToolEntries, toSurfaceEntry } from "./tools/index.js";
import {
  createOrReinstallFromSkill,
  resolveOptionalWorkspaceServerId,
  resolveWorkspaceServerId,
  workspaceCreateForbidden,
  type WorkspaceBinding,
} from "./tools/workspace.js";

/** Surface metadata for tools that still live in the overlay table (deleted per domain). */
const LEGACY_TOOL_SURFACE: Record<string, ToolSurfaceMeta | undefined> = TOOL_SURFACE_OVERLAY;

export {
  createOrReinstallFromSkill,
  resolveWorkspaceServerId,
  workspaceCreateForbidden,
  type WorkspaceBinding,
};

export async function createLlmClient(
  db: Db,
  config: AppConfig,
): Promise<LlmClient> {
  const stored = await getSetting<LlmSettings>(db, LLM_SETTINGS_KEY);
  const fallback: LlmSettings = {
    provider: config.llmMode,
    preset: config.llmMode === "ollama" ? "ollama" : "venice",
  };
  const settings = stored ?? fallback;
  const presetId = resolveLlmPreset(settings);
  const preset = getLlmPreset(presetId);

  const envVenice =
    process.env.PLAYON_VENICE_API_KEY?.trim() || process.env.VENICE_API_KEY?.trim() || "";

  const storedKey = (): string => {
    if (!settings.apiKeyEncrypted) return "";
    try {
      return decryptSecret(config.sessionSecret, settings.apiKeyEncrypted);
    } catch {
      // Session secret rotated (common after prod install) — fall back to env.
      return "";
    }
  };

  const baseUrl =
    (preset.baseUrlEditable ? settings.baseUrl?.trim() : undefined) ||
    preset.baseUrl ||
    settings.baseUrl?.trim() ||
    getLlmPreset("venice").baseUrl;
  const model =
    settings.model?.trim() || preset.defaultModel || getLlmPreset("venice").defaultModel;

  if (preset.transport === "ollama") {
    return new OpenAICompatibleLlmClient(baseUrl, storedKey(), model, "ollama");
  }

  const apiKey = storedKey() || (presetId === "venice" ? envVenice : "");
  if (preset.requiresApiKey && !apiKey) {
    throw new Error(
      "llm_api_key_required: set an API key under Settings → In-app agents, or PLAYON_VENICE_API_KEY for Venice (re-save the key if PLAYON_SESSION_SECRET changed)",
    );
  }
  return new OpenAICompatibleLlmClient(baseUrl, apiKey, model, "openai_compatible");
}

export type PlayOnToolRegistry = {
  getDefinitions: () => ToolDefinition[];
  invoke: (
    name: string,
    args: Record<string, unknown>,
    invokeOptions?: { confirmPolicy?: ConfirmPolicy; autoApproveActor?: string },
  ) => Promise<unknown>;
  registerInto: (orchestrator: Orchestrator) => void;
  /** Sorted names + requiresConfirm — for parity tests across Venice/Ollama/MCP. */
  parityFingerprint: () => Array<{ name: string; requiresConfirm: boolean }>;
  /** Composed entries (def + surface + policy) for structural checks. */
  entries: () => ToolEntry[];
};

export type PlayOnToolRegistryOptions = {
  confirmGate?: ConfirmGate;
  workspaceServerId?: string;
};

/**
 * Registry plus the catalog projection it composed.
 * Callers read confirm copy / activity verbs / XP from `surface` — never from a process global.
 */
export type PlayOnTools = {
  registry: PlayOnToolRegistry;
  surface: ToolSurface;
};

/**
 * Single tool registry for Canvas (Venice/Ollama) and MCP.
 * Backend/transport must not fork this catalog.
 */
export function createPlayOnToolRegistry(
  plane: ControlPlane,
  options: PlayOnToolRegistryOptions = {},
): PlayOnTools {
  const { config } = plane;
  /** Binds on first create/import so mid-turn sibling creates cannot fork. */
  const workspace: WorkspaceBinding = { serverId: options.workspaceServerId };
  const skillRoots = skillsRootsForWorkspace(
    config.skillsRoots,
    config.dataRoot,
    workspace.serverId,
  );
  const {
    servers,
    snapshots,
    archives,
    net,
    placement,
    offNode,
    addNode,
    watchers,
    watcherEngine,
  } = plane;

  const tools = new Map<string, ToolEntry>();
  for (const entry of composeToolEntries({ plane, workspace, skillRoots })) {
    tools.set(entry.def.name, entry);
  }

  /**
   * Shim for domains not yet colocated as ToolEntry modules: definitions live in the
   * array below and metadata still comes from the overlay table.
   */
  const registerTool = (def: ToolDefinition, handler: ToolHandler) => {
    tools.set(def.name, {
      def,
      surface: LEGACY_TOOL_SURFACE[def.name],
      workspacePolicy: "none",
      handler,
    });
  };

  // Tool names must match ^[a-zA-Z0-9_-]+$ for Venice / many OpenAI-compatible gateways.
  const toolDefs: ToolDefinition[] = [
    {
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
    {
      name: "snapshot_restore",
      description: "Restore a server from a snapshot",
      requiresConfirm: true,
      parameters: {
        type: "object",
        properties: { snapshotId: { type: "string" } },
        required: ["snapshotId"],
      },
    },
    {
      name: "snapshot_list",
      description: "List snapshots, optionally filtered by server",
      parameters: {
        type: "object",
        properties: { serverId: { type: "string" } },
      },
    },
    {
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
    {
      name: "archive_extract",
      description:
        "Extract a zip or tar.gz archive already in the server jail into a destination directory (path-jailed). Use after fetch_url for mod packs.",
      requiresConfirm: true,
      parameters: {
        type: "object",
        properties: {
          serverId: { type: "string" },
          archivePath: { type: "string", description: "Relative path to the archive inside the server data dir" },
          destDir: { type: "string", description: "Relative destination directory inside the server data dir" },
          stripComponents: {
            type: "number",
            description: "Strip leading path components from archive entries (like tar --strip-components)",
          },
        },
        required: ["serverId", "archivePath", "destDir"],
      },
    },
    {
      name: "fetch_url",
      description:
        "Download an HTTP(S) URL into a path under a server data directory (jailed). Follows redirects; max 100MB. Blocks private/link-local destinations except explicit localhost/127.0.0.1.",
      requiresConfirm: true,
      parameters: {
        type: "object",
        properties: {
          serverId: { type: "string" },
          url: { type: "string" },
          destPath: { type: "string" },
          headers: {
            type: "object",
            description: "Optional request headers (Host/Content-Length and hop-by-hop headers are ignored)",
            additionalProperties: { type: "string" },
          },
        },
        required: ["serverId", "url", "destPath"],
      },
    },
    {
      name: "placement_suggest",
      description:
        "Rank nodes for a skill by OS, Docker, disk, online status, and placement kind (Local / Remote / Cloud). Use before servers_create_from_skill when choosing nodeId.",
      parameters: {
        type: "object",
        properties: { skillName: { type: "string" } },
        required: ["skillName"],
      },
    },
    {
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
    {
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
    {
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
    {
      name: "backup_offnode_list",
      description: "List off-node backups under the configured external target",
      parameters: {
        type: "object",
        properties: { serverId: { type: "string" } },
      },
    },
    {
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
    {
      name: "rcon_exec",
      description:
        "Run a Minecraft RCON command (no leading slash). Auto-heals known legacy gamerules (doDaylightCycle→advance_time, keepInventory→keep_inventory, etc.). Always-day: `time set day` then `gamerule advance_time false`. On rcon_command_failed: read body/hint, try one different approach, then explain — never spam the same failing command. Prefer rcon_say for chat.",
      parameters: {
        type: "object",
        properties: {
          serverId: { type: "string" },
          command: { type: "string" },
        },
        required: ["serverId", "command"],
      },
    },
    {
      name: "rcon_say",
      description: "Broadcast a chat message to players via RCON say",
      parameters: {
        type: "object",
        properties: {
          serverId: { type: "string" },
          message: { type: "string" },
        },
        required: ["serverId", "message"],
      },
    },
    {
      name: "steamcmd_app_update",
      description:
        "Run host SteamCMD +app_update into the server jail. On Linux, auto-downloads SteamCMD into ~/steamcmd when missing (set PLAYON_STEAMCMD_AUTO=0 to disable). Prefer this before starting Steam-native games (Rust, etc.).",
      requiresConfirm: true,
      parameters: {
        type: "object",
        properties: {
          serverId: { type: "string" },
          appId: { type: "number" },
          installDir: { type: "string" },
          validate: { type: "boolean" },
        },
        required: ["serverId", "appId"],
      },
    },
    {
      name: "watchers_list",
      description: "List watchers (scheduled/event automations), optionally filtered by serverId.",
      parameters: {
        type: "object",
        properties: { serverId: { type: "string" } },
        additionalProperties: false,
      },
    },
    {
      name: "watchers_get",
      description: "Get a watcher by id.",
      parameters: {
        type: "object",
        properties: { watcherId: { type: "string" } },
        required: ["watcherId"],
      },
    },
    {
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
    {
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
    {
      name: "watchers_delete",
      description: "Delete a watcher by id.",
      requiresConfirm: true,
      parameters: {
        type: "object",
        properties: { watcherId: { type: "string" } },
        required: ["watcherId"],
      },
    },
    {
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
    {
      name: "watchers_run_now",
      description: "Manually fire a watcher once (bypasses enabled check; still records a run).",
      parameters: {
        type: "object",
        properties: { watcherId: { type: "string" } },
        required: ["watcherId"],
      },
    },
    {
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
  ];




  const legacyDefByName = new Map(toolDefs.map((d) => [d.name, d]));
  const tool = (name: string): ToolDefinition => {
    const def = legacyDefByName.get(name);
    if (!def) throw new Error(`missing_tool_def: ${name}`);
    return def;
  };

  registerTool(tool("snapshot_create"), async (args) => {
    const resolved = resolveWorkspaceServerId(args, workspace.serverId);
    if (!resolved.ok) return resolved.error;
    const label = args.label ? String(args.label) : `snapshot-${Date.now()}`;
    const snapshot = await snapshots.create(resolved.serverId, label);
    return { snapshotId: snapshot.id, label: snapshot.label, path: snapshot.path };
  });

  registerTool(tool("snapshot_restore"), async (args) => {
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
  });

  registerTool(tool("snapshot_list"), async (args) => {
    const resolved = resolveOptionalWorkspaceServerId(args, workspace.serverId);
    if (!resolved.ok) return resolved.error;
    const rows = await snapshots.list(resolved.serverId);
    return rows.map((s) => ({
      id: s.id,
      serverId: s.serverId,
      label: s.label,
      createdAt: s.createdAt.toISOString(),
    }));
  });

  registerTool(tool("snapshot_enforce_retention"), async (args) => {
    const resolved = resolveOptionalWorkspaceServerId(args, workspace.serverId);
    if (!resolved.ok) return resolved.error;
    return snapshots.enforceRetention(resolved.serverId, {
      maxCount: args.maxCount !== undefined ? Number(args.maxCount) : 10,
      maxAgeHours: args.maxAgeHours !== undefined ? Number(args.maxAgeHours) : 72,
    });
  });

  registerTool(tool("archive_extract"), async (args) => {
    const resolved = resolveWorkspaceServerId(args, workspace.serverId);
    if (!resolved.ok) return resolved.error;
    return archives.extract({
      serverId: resolved.serverId,
      archivePath: String(args.archivePath),
      destDir: String(args.destDir),
      stripComponents:
        args.stripComponents !== undefined ? Number(args.stripComponents) : undefined,
    });
  });

  registerTool(tool("fetch_url"), async (args) => {
    const resolved = resolveWorkspaceServerId(args, workspace.serverId);
    if (!resolved.ok) return resolved.error;
    const headers =
      args.headers && typeof args.headers === "object" && !Array.isArray(args.headers)
        ? Object.fromEntries(
            Object.entries(args.headers as Record<string, unknown>)
              .filter(([, v]) => typeof v === "string")
              .map(([k, v]) => [k, String(v)]),
          )
        : undefined;
    return net.fetchUrl({
      serverId: resolved.serverId,
      url: String(args.url),
      destPath: String(args.destPath),
      headers,
    });
  });

  registerTool(tool("placement_suggest"), async (args) => placement.plan(String(args.skillName)));

  registerTool(tool("nodes_add"), async (args) => {
    const kind = String(args.kind) === "cloud" ? "cloud" : "lan";
    return addNode.addViaSsh({
      kind,
      host: String(args.host),
      username: String(args.username),
      password: args.password != null ? String(args.password) : undefined,
      privateKey: args.privateKey != null ? String(args.privateKey) : undefined,
      nodeId: args.nodeId != null ? String(args.nodeId) : undefined,
      nodeName: args.nodeName != null ? String(args.nodeName) : undefined,
      port: typeof args.port === "number" ? args.port : undefined,
    });
  });

  registerTool(tool("nodes_remove"), async (args) =>
    addNode.removeNode(String(args.nodeId), { force: args.force === true }),
  );

  registerTool(tool("backup_offnode"), async (args) => {
    const resolved = resolveWorkspaceServerId(args, workspace.serverId);
    if (!resolved.ok) return resolved.error;
    return offNode.backupServer(
      resolved.serverId,
      args.label ? String(args.label) : undefined,
    );
  });

  registerTool(tool("backup_offnode_list"), async (args) => {
    const resolved = resolveOptionalWorkspaceServerId(args, workspace.serverId);
    if (!resolved.ok) return resolved.error;
    return offNode.list(resolved.serverId);
  });

  registerTool(tool("backup_offnode_restore"), async (args) => {
    const resolved = resolveOptionalWorkspaceServerId(args, workspace.serverId);
    if (!resolved.ok) return resolved.error;
    return offNode.restore(String(args.backupId), resolved.serverId);
  });

  registerTool(tool("rcon_exec"), async (args) => {
    const resolved = resolveWorkspaceServerId(args, workspace.serverId);
    if (!resolved.ok) return resolved.error;
    const endpoint = await servers.getRconEndpoint(resolved.serverId);
    if (!endpoint) {
      return {
        error: "rcon_not_configured",
        hint: "Start a server whose skill adminDialect supports RCON, then retry.",
      };
    }
    try {
      const result = await rconExecWithSelfHeal(endpoint, String(args.command));
      return { serverId: resolved.serverId, ...result };
    } catch (err) {
      return { error: err instanceof Error ? err.message : "rcon_failed" };
    }
  });

  registerTool(tool("rcon_say"), async (args) => {
    const resolved = resolveWorkspaceServerId(args, workspace.serverId);
    if (!resolved.ok) return resolved.error;
    const endpoint = await servers.getRconEndpoint(resolved.serverId);
    if (!endpoint) {
      return {
        error: "rcon_not_configured",
        hint: "Start a server whose skill adminDialect supports RCON, then retry.",
      };
    }
    const message = String(args.message);
    try {
      const result = await rconExec(endpoint, `say ${message}`);
      return { serverId: resolved.serverId, message, body: result.body };
    } catch (err) {
      return { error: err instanceof Error ? err.message : "rcon_failed" };
    }
  });

  registerTool(tool("steamcmd_app_update"), async (args) => {
    const resolved = resolveWorkspaceServerId(args, workspace.serverId);
    if (!resolved.ok) return resolved.error;
    const server = await servers.get(resolved.serverId);
    if (!server) return { error: `unknown_server: ${resolved.serverId}` };
    try {
      const { dispatchNodeJob, nodeServerRelPath } = await import("./node-runtime.js");
      const result = await dispatchNodeJob<{
        appId: number;
        installDir: string;
        exitCode: number;
        stdout: string;
      }>({
        nodeId: server.nodeId,
        kind: "steamcmd_app_update",
        args: {
          serverRel: nodeServerRelPath(server.id),
          appId: Number(args.appId),
          installDirRel: args.installDir ? String(args.installDir) : undefined,
          validate: args.validate === undefined ? true : Boolean(args.validate),
        },
        timeoutMs: 600_000,
        localHandler: () =>
          steamcmdAppUpdate({
            serverDataPath: server.dataPath,
            appId: Number(args.appId),
            installDirRel: args.installDir ? String(args.installDir) : undefined,
            validate: args.validate === undefined ? true : Boolean(args.validate),
          }),
      });
      return {
        serverId: resolved.serverId,
        appId: result.appId,
        installDir: result.installDir,
        exitCode: result.exitCode,
        // Truncated logs only — never include secrets.
        stdoutTail: result.stdout.slice(-800),
      };
    } catch (err) {
      if (err instanceof SteamcmdNotFoundError) {
        return { error: err.message };
      }
      return { error: err instanceof Error ? err.message : "steamcmd_failed" };
    }
  });

  registerTool(tool("watchers_list"), async (args) => {
    const resolved = resolveOptionalWorkspaceServerId(args, workspace.serverId);
    if (!resolved.ok) return resolved.error;
    const list = await watchers.list(resolved.serverId);
    return { watchers: list };
  });

  registerTool(tool("watchers_get"), async (args) => {
    const w = await watchers.get(String(args.watcherId));
    if (!w) return { error: "not_found" };
    if (workspace.serverId && w.serverId !== workspace.serverId) {
      return { error: "workspace_server_mismatch", workspaceServerId: workspace.serverId };
    }
    return { watcher: w };
  });

  registerTool(tool("watchers_create"), async (args) => {
    const resolved = resolveWorkspaceServerId(args, workspace.serverId);
    if (!resolved.ok) return resolved.error;
    try {
      const watcher = await watchers.create({
        serverId: resolved.serverId,
        name: String(args.name),
        enabled: args.enabled !== undefined ? Boolean(args.enabled) : true,
        trigger: args.trigger as CreateWatcherInput["trigger"],
        action: args.action as CreateWatcherInput["action"],
        cooldownMs: args.cooldownMs !== undefined ? Number(args.cooldownMs) : 60_000,
        debounceMs: args.debounceMs !== undefined ? Number(args.debounceMs) : 0,
      });
      return { watcher };
    } catch (err) {
      return { error: err instanceof Error ? err.message : "create_failed" };
    }
  });

  registerTool(tool("watchers_update"), async (args) => {
    const existing = await watchers.get(String(args.watcherId));
    if (!existing) return { error: "not_found" };
    if (workspace.serverId && existing.serverId !== workspace.serverId) {
      return { error: "workspace_server_mismatch", workspaceServerId: workspace.serverId };
    }
    try {
      const watcher = await watchers.update(existing.id, {
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
  });

  registerTool(tool("watchers_delete"), async (args) => {
    const existing = await watchers.get(String(args.watcherId));
    if (!existing) return { error: "not_found" };
    if (workspace.serverId && existing.serverId !== workspace.serverId) {
      return { error: "workspace_server_mismatch", workspaceServerId: workspace.serverId };
    }
    await watchers.delete(existing.id);
    return { ok: true, deleted: existing.id };
  });

  registerTool(tool("watchers_enable"), async (args) => {
    const existing = await watchers.get(String(args.watcherId));
    if (!existing) return { error: "not_found" };
    if (workspace.serverId && existing.serverId !== workspace.serverId) {
      return { error: "workspace_server_mismatch", workspaceServerId: workspace.serverId };
    }
    const watcher = await watchers.setEnabled(existing.id, Boolean(args.enabled));
    return { watcher };
  });

  registerTool(tool("watchers_run_now"), async (args) => {
    const existing = await watchers.get(String(args.watcherId));
    if (!existing) return { error: "not_found" };
    if (workspace.serverId && existing.serverId !== workspace.serverId) {
      return { error: "workspace_server_mismatch", workspaceServerId: workspace.serverId };
    }
    await watcherEngine.enqueue(existing, { kind: "manual" }, { force: true });
    return { ok: true, watcherId: existing.id, queued: true };
  });

  registerTool(tool("watchers_runs_list"), async (args) => {
    const existing = await watchers.get(String(args.watcherId));
    if (!existing) return { error: "not_found" };
    if (workspace.serverId && existing.serverId !== workspace.serverId) {
      return { error: "workspace_server_mismatch", workspaceServerId: workspace.serverId };
    }
    const limit = args.limit !== undefined ? Number(args.limit) : 50;
    const runs = await watchers.listRuns(existing.id, limit);
    return { runs };
  });

  const registry: PlayOnToolRegistry = {
    getDefinitions: () => [...tools.values()].map((t) => t.def),
    parityFingerprint: () =>
      [...tools.values()]
        .map((t) => ({
          name: t.def.name,
          requiresConfirm: Boolean(t.def.requiresConfirm),
        }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    entries: () => [...tools.values()],
    registerInto(orchestrator: Orchestrator) {
      for (const entry of tools.values()) {
        orchestrator.registerEntry(entry);
      }
    },
    async invoke(name, args, invokeOptions = {}) {
      const entry = tools.get(name);
      if (!entry) return { error: `unknown_tool: ${name}` };
      try {
        return await runToolInvocation(entry, args, {
          confirmGate: options.confirmGate,
          confirmPolicy: invokeOptions.confirmPolicy ?? "gate",
          autoApproveActor: invokeOptions.autoApproveActor,
        });
      } catch (err) {
        return { error: err instanceof Error ? err.message : "tool_failed" };
      }
    },
  };

  return {
    registry,
    surface: createToolSurface([...tools.values()].map(toSurfaceEntry)),
  };
}

/**
 * Catalog projection without binding handlers to a turn.
 * Chat and watcher activity/XP reporting read confirm copy and verbs from here.
 */
export function createPlayOnToolSurface(
  plane: ControlPlane,
  options: PlayOnToolRegistryOptions = {},
): ToolSurface {
  return createPlayOnToolRegistry(plane, options).surface;
}

/** Venice/Ollama chat path — same registry as MCP, LLM loop on top. */
export function createOrchestrator(
  plane: ControlPlane,
  llm: LlmClient,
  options: {
    confirmGate?: ConfirmGate;
    stream?: ChatStreamSink;
    workspaceServerId?: string;
    abortSignal?: AbortSignal;
    confirmPolicy?: "gate" | "auto";
    autoApproveActor?: string;
  } = {},
): Orchestrator {
  const { registry } = createPlayOnToolRegistry(plane, {
    confirmGate: options.confirmGate,
    workspaceServerId: options.workspaceServerId,
  });
  const orch = new Orchestrator(llm, {
    confirmGate: options.confirmGate,
    stream: options.stream,
    workspaceServerId: options.workspaceServerId,
    abortSignal: options.abortSignal,
    confirmPolicy: options.confirmPolicy,
    autoApproveActor: options.autoApproveActor,
  });
  registry.registerInto(orch);
  return orch;
}

// Re-export for callers that need direct snapshot access in tests or future routes.
export { SnapshotService, withSnapshot };
