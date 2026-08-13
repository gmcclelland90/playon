import type {
  ChatStreamSink,
  ConfirmGate,
  ConfirmPolicy,
  ToolCatalogStage,
  ToolDefinition,
  ToolEntry,
  ToolSurface,
} from "@playon/agent-core";
import {
  createToolSurface,
  isSequentialToolCallingBackend,
  Orchestrator,
  OpenAICompatibleLlmClient,
  runToolInvocation,
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
import { SnapshotService, withSnapshot } from "./snapshots.js";
import { composeToolEntries, toSurfaceEntry } from "./tools/index.js";
import {
  createOrReinstallFromSkill,
  resolveWorkspaceServerId,
  workspaceCreateForbidden,
  type WorkspaceBinding,
} from "./tools/workspace.js";

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
  const sequential = isSequentialToolCallingBackend({
    preset: presetId,
    baseUrl,
    model,
  });
  return new OpenAICompatibleLlmClient(baseUrl, apiKey, model, "openai_compatible", {
    parallelToolCalls: false,
    maxToolCallsPerCompletion: sequential ? 1 : undefined,
  });
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
  catalog?: ToolCatalogStage;
  /** Chat/session: reject targeting servers this turn did not bind or create. */
  restrictTargets?: boolean;
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
  const workspace: WorkspaceBinding = {
    serverId: options.workspaceServerId,
    restrictTargets: options.restrictTargets,
  };
  const skillRoots = skillsRootsForWorkspace(
    config.skillsRoots,
    config.dataRoot,
    workspace.serverId,
  );

  const tools = new Map<string, ToolEntry>();
  for (const entry of composeToolEntries({
    plane,
    workspace,
    skillRoots,
    catalog: options.catalog ?? "full",
  })) {
    tools.set(entry.def.name, entry);
  }

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
    catalog?: ToolCatalogStage;
    restrictTargets?: boolean;
    sessionCreatedServerIds?: Iterable<string>;
  } = {},
): Orchestrator {
  const { registry } = createPlayOnToolRegistry(plane, {
    confirmGate: options.confirmGate,
    workspaceServerId: options.workspaceServerId,
    catalog: options.catalog,
    restrictTargets: options.restrictTargets,
  });
  const orch = new Orchestrator(llm, {
    confirmGate: options.confirmGate,
    stream: options.stream,
    workspaceServerId: options.workspaceServerId,
    abortSignal: options.abortSignal,
    confirmPolicy: options.confirmPolicy,
    autoApproveActor: options.autoApproveActor,
    catalogStage: options.catalog,
    sessionCreatedServerIds: options.sessionCreatedServerIds,
  });
  registry.registerInto(orch);
  return orch;
}

// Re-export for callers that need direct snapshot access in tests or future routes.
export { SnapshotService, withSnapshot };
