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
import { getLlmPreset } from "@playon/shared";
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
  const { servers, archives, net } = plane;

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
  ];

  const legacyDefByName = new Map(toolDefs.map((d) => [d.name, d]));
  const tool = (name: string): ToolDefinition => {
    const def = legacyDefByName.get(name);
    if (!def) throw new Error(`missing_tool_def: ${name}`);
    return def;
  };

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
