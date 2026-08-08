import fs from "node:fs";
import path from "node:path";
import type {
  ChatStreamSink,
  ConfirmGate,
  ConfirmPolicy,
  ToolDefinition,
  ToolHandler,
} from "@playon/agent-core";
import {
  installToolSurface,
  mergeToolSurface,
  Orchestrator,
  OpenAICompatibleLlmClient,
  runToolInvocation,
  TOOL_SURFACE_OVERLAY,
  toToolDefinition,
  type LlmClient,
} from "@playon/agent-core";
import { queryDialectToolEnum } from "@playon/server-query";
import {
  getLlmPreset,
  type CreateWatcherInput,
  type QueryDialect,
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
  SKILLS_CATALOG_KEY,
  type LlmSettings,
  type SkillsCatalogSettings,
} from "./settings.js";
import {
  annotateCatalogInstalled,
  installSkillFromCatalog,
} from "./catalog-install.js";
import {
  fetchSkillsCatalog,
  resolveSkillsCatalogUrl,
  searchCatalog,
} from "./skills-catalog.js";
import { listSkills, loadSkillMetadata, skillsRootsForWorkspace } from "./skills.js";
import { nodeJobService } from "./node-jobs.js";
import { rconExec, rconExecWithSelfHeal } from "./rcon.js";
import { isPlayerPanelLiveStatus, safeQueryLive } from "./server-panel.js";
import type { ServerService } from "./servers.js";
import { SnapshotService, withSnapshot } from "./snapshots.js";
import { SteamcmdNotFoundError, steamcmdAppUpdate } from "./steamcmd.js";

const QUERY_DIALECT_TOOL_ENUM = queryDialectToolEnum();

/** Resolve serverId for tools inside a server workspace (default + cross-server jail). */
/** Mutable chat↔server binding for the duration of an agent turn. */
export type WorkspaceBinding = { serverId: string | undefined };

/** Bound maintain chat cannot import/provision a sibling server identity. */
export function workspaceCreateForbidden(
  workspaceServerId: string | undefined,
  hint: string,
): Record<string, unknown> | null {
  if (!workspaceServerId) return null;
  return {
    error: "workspace_create_forbidden",
    workspaceServerId,
    hint,
  };
}

/**
 * First create in an unbound chat binds the workspace.
 * Later creates reinstall in place (same server id) instead of forking a sibling.
 */
export async function createOrReinstallFromSkill(
  servers: ServerService,
  workspace: WorkspaceBinding,
  args: { skillName: string; serverName?: string; nodeId?: string },
): Promise<{ server: Awaited<ReturnType<ServerService["createFromSkill"]>>; mode: "created" | "reinstalled" }> {
  if (workspace.serverId) {
    const server = await servers.reinstallFromSkill(workspace.serverId, args);
    return { server, mode: "reinstalled" };
  }
  const server = await servers.createFromSkill(args);
  workspace.serverId = server.id;
  return { server, mode: "created" };
}

export function resolveWorkspaceServerId(
  args: Record<string, unknown>,
  workspaceServerId: string | undefined,
): { ok: true; serverId: string } | { ok: false; error: Record<string, unknown> } {
  const raw = args.serverId;
  const requested =
    raw !== undefined && raw !== null && String(raw).trim() !== ""
      ? String(raw)
      : undefined;
  if (workspaceServerId) {
    if (requested && requested !== workspaceServerId) {
      return {
        ok: false,
        error: {
          error: "workspace_server_mismatch",
          workspaceServerId,
          requestedServerId: requested,
        },
      };
    }
    return { ok: true, serverId: requested ?? workspaceServerId };
  }
  if (!requested) {
    return { ok: false, error: { error: "serverId_required" } };
  }
  return { ok: true, serverId: requested };
}

function resolveOptionalWorkspaceServerId(
  args: Record<string, unknown>,
  workspaceServerId: string | undefined,
): { ok: true; serverId: string | undefined } | { ok: false; error: Record<string, unknown> } {
  const raw = args.serverId;
  const requested =
    raw !== undefined && raw !== null && String(raw).trim() !== ""
      ? String(raw)
      : undefined;
  if (workspaceServerId) {
    if (requested && requested !== workspaceServerId) {
      return {
        ok: false,
        error: {
          error: "workspace_server_mismatch",
          workspaceServerId,
          requestedServerId: requested,
        },
      };
    }
    return { ok: true, serverId: requested ?? workspaceServerId };
  }
  return { ok: true, serverId: requested };
}

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
};

export type PlayOnToolRegistryOptions = {
  confirmGate?: ConfirmGate;
  workspaceServerId?: string;
};

/**
 * Single tool registry for Canvas (Venice/Ollama) and MCP.
 * Backend/transport must not fork this catalog.
 */
export function createPlayOnToolRegistry(
  plane: ControlPlane,
  options: PlayOnToolRegistryOptions = {},
): PlayOnToolRegistry {
  const { config } = plane;
  /** Binds on first create/import so mid-turn sibling creates cannot fork. */
  const workspace: WorkspaceBinding = { serverId: options.workspaceServerId };
  const skillRoots = skillsRootsForWorkspace(
    config.skillsRoots,
    config.dataRoot,
    workspace.serverId,
  );
  const {
    db,
    servers,
    snapshots,
    serverFs,
    archives,
    net,
    drafts,
    skillPackages,
    placement,
    migrate,
    offNode,
    importLocal,
    importSftp,
    panel,
    playerPanel,
    queries,
    health,
    addNode,
    watchers,
    watcherEngine,
  } = plane;

  async function catalogUrl(): Promise<string> {
    const stored = await getSetting<SkillsCatalogSettings>(db, SKILLS_CATALOG_KEY);
    return resolveSkillsCatalogUrl(process.env.PLAYON_SKILLS_CATALOG_URL, stored?.catalogUrl);
  }

  const tools = new Map<string, { def: ToolDefinition; handler: ToolHandler }>();
  const registerTool = (def: ToolDefinition, handler: ToolHandler) => {
    tools.set(def.name, { def, handler });
  };



  // Tool names must match ^[a-zA-Z0-9_-]+$ for Venice / many OpenAI-compatible gateways.
  const toolDefs: ToolDefinition[] = [
    {
      name: "skill_list",
      description:
        "List installable skills (includes containerSupport: full|partial|none). Prefer containerSupport=full on Docker hosts.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
    {
      name: "skill_draft_save",
      description:
        "Save a draft skill for later promotion. Optional queryConnectorSource writes query/connector.mjs and sets queryDialect=skill_module.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string" },
          game: { type: "string" },
          description: { type: "string" },
          installGuide: { type: "string" },
          containerSupport: { type: "string", enum: ["full", "partial", "none"] },
          warnings: { type: "string" },
          queryConnectorSource: { type: "string" },
          queryGuide: { type: "string" },
        },
        required: ["name", "game", "description", "installGuide"],
      },
    },
    {
      name: "skill_draft_list",
      description: "List draft skills",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
    {
      name: "skill_promote",
      description: "Promote a draft skill to an installable skill",
      requiresConfirm: true,
      parameters: {
        type: "object",
        properties: { slug: { type: "string" } },
        required: ["slug"],
      },
    },
    {
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
    {
      name: "servers_start",
      description: "Start a server",
      parameters: {
        type: "object",
        properties: { serverId: { type: "string" } },
        required: ["serverId"],
      },
    },
    {
      name: "servers_stop",
      description: "Stop a server",
      requiresConfirm: true,
      parameters: {
        type: "object",
        properties: { serverId: { type: "string" } },
        required: ["serverId"],
      },
    },
    {
      name: "servers_restart",
      description: "Restart a server (stop then start)",
      requiresConfirm: true,
      parameters: {
        type: "object",
        properties: { serverId: { type: "string" } },
        required: ["serverId"],
      },
    },
    {
      name: "servers_list",
      description: "List servers",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },

    {
      name: "panel_publish",
      description:
        "Replace all player panel blocks for a server. Always include join_info + client_setup after servers_start so players can connect. Include every block you want to keep — omitted blocks are removed. Types: server_status, join_info, client_setup, guide, vote, readiness, announcement, file_drop, discovery. join_info address/port and live stats (players/map/mode) are filled from the control plane — do not invent player counts. Optional connectCommand / steamConnectUrl (steam:// only). Blocks are only visible on the public player panel while the server is starting or running — start the server first. Prefer body.notes / body.instructions / body.steps for setup.",
      parameters: {
        type: "object",
        properties: {
          serverId: { type: "string" },
          blocks: {
            type: "array",
            items: {
              type: "object",
              properties: {
                type: {
                  type: "string",
                  enum: [
                    "server_status",
                    "join_info",
                    "client_setup",
                    "guide",
                    "vote",
                    "readiness",
                    "announcement",
                    "file_drop",
                    "discovery",
                  ],
                },
                title: { type: "string" },
                body: {
                  type: "object",
                  description:
                    "join_info: { connectCommand?: string, steamConnectUrl?: string, game?: string }. client_setup: { notes: string }. Prefer skill join metadata; steamConnectUrl must be steam:// when set.",
                },
                sortOrder: { type: "number" },
              },
              required: ["type", "title"],
            },
          },
        },
        required: ["blocks"],
      },
    },
    {
      name: "panel_list",
      description: "List player panel blocks",
      parameters: {
        type: "object",
        properties: { serverId: { type: "string" } },
      },
    },
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
      name: "fs_list",
      description: "List files under a server data directory (path-jailed)",
      parameters: {
        type: "object",
        properties: {
          serverId: { type: "string" },
          path: { type: "string", description: "Relative path inside the server data dir" },
        },
        required: ["serverId"],
      },
    },
    {
      name: "fs_read",
      description:
        "Read a text file under a server data directory (path-jailed). Optional offset/maxBytes for large files (max 512KB per read).",
      parameters: {
        type: "object",
        properties: {
          serverId: { type: "string" },
          path: { type: "string" },
          offset: { type: "number", description: "Byte offset to start reading from" },
          maxBytes: { type: "number", description: "Max bytes to return (capped at 512KB)" },
        },
        required: ["serverId", "path"],
      },
    },
    {
      name: "fs_write",
      description: "Write a text file under a server data directory (path-jailed)",
      requiresConfirm: true,
      parameters: {
        type: "object",
        properties: {
          serverId: { type: "string" },
          path: { type: "string" },
          content: { type: "string" },
        },
        required: ["serverId", "path", "content"],
      },
    },
    {
      name: "fs_delete",
      description: "Delete a file or directory under a server data directory (path-jailed, recursive for dirs)",
      requiresConfirm: true,
      parameters: {
        type: "object",
        properties: {
          serverId: { type: "string" },
          path: { type: "string" },
        },
        required: ["serverId", "path"],
      },
    },
    {
      name: "fs_rename",
      description: "Rename or move a path inside a server data directory (path-jailed)",
      requiresConfirm: true,
      parameters: {
        type: "object",
        properties: {
          serverId: { type: "string" },
          from: { type: "string" },
          to: { type: "string" },
          overwrite: { type: "boolean" },
        },
        required: ["serverId", "from", "to"],
      },
    },
    {
      name: "fs_copy",
      description: "Copy a file or directory tree inside a server data directory (path-jailed)",
      requiresConfirm: true,
      parameters: {
        type: "object",
        properties: {
          serverId: { type: "string" },
          from: { type: "string" },
          to: { type: "string" },
          overwrite: { type: "boolean" },
        },
        required: ["serverId", "from", "to"],
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
    {
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
      name: "servers_health_check",
      description:
        "Run skill-declared health checks for a server. Set remediate=true to auto-restart on known restartable failures.",
      parameters: {
        type: "object",
        properties: {
          serverId: { type: "string" },
          remediate: { type: "boolean" },
        },
        required: ["serverId"],
      },
    },
    {
      name: "skill_read",
      description:
        "Read guides/*.md from an installed skill (default INSTALL.md; use MODDING.md for Workshop/mod runbooks). Prefer this before drafting a new skill.",
      parameters: {
        type: "object",
        properties: {
          skillName: { type: "string" },
          guide: {
            type: "string",
            description: "Guide basename without path, e.g. INSTALL.md (default INSTALL.md)",
          },
        },
        required: ["skillName"],
      },
    },
    {
      name: "skill_export",
      description: "Export an installable skill as a zip under data/exports/",
      parameters: {
        type: "object",
        properties: { skillName: { type: "string" } },
        required: ["skillName"],
      },
    },
    {
      name: "skill_import",
      description: "Import a skill zip from a path under the host data root",
      requiresConfirm: true,
      parameters: {
        type: "object",
        properties: {
          zipPath: { type: "string" },
          overwrite: { type: "boolean" },
        },
        required: ["zipPath"],
      },
    },
    {
      name: "skill_search",
      description:
        "Search the public PlayOn skill catalog (playon.games) for official .skill.zip packages. Use when skill_list has no local match for the requested game.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Game or skill name / tags (e.g. minecraft, rust). Empty returns the full catalog.",
          },
        },
      },
    },
    {
      name: "skill_install_url",
      description:
        "Download and install a skill from the public catalog. Prefer name from skill_search; downloadUrl must match a catalog entry. Verifies sha256 when the catalog provides one.",
      requiresConfirm: true,
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Catalog skill name, e.g. games.minecraft-paper" },
          downloadUrl: { type: "string", description: "Exact downloadUrl from skill_search" },
          overwrite: { type: "boolean" },
        },
      },
    },
    {
      name: "skill_promote_server",
      description: "Promote a per-server skill folder to the global skills library",
      requiresConfirm: true,
      parameters: {
        type: "object",
        properties: {
          serverId: { type: "string" },
          skillSlug: { type: "string" },
          overwrite: { type: "boolean" },
        },
        required: ["serverId", "skillSlug"],
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
    {
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
      name: "node_ping",
      description:
        "Enqueue a ping job on a node-agent and wait for the result (proves remote job execution).",
      parameters: {
        type: "object",
        properties: { nodeId: { type: "string" } },
        required: ["nodeId"],
      },
    },
    {
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
    {
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
    {
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
    {
      name: "servers_query",
      description:
        "Query live game stats (players, map, mode, …) for a managed server via its skill queryDialect or skill_module connector.",
      parameters: {
        type: "object",
        properties: { serverId: { type: "string" } },
        required: ["serverId"],
      },
    },
    {
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
    {
      name: "skill_draft_set_query_connector",
      description:
        "Write query/connector.mjs on an existing draft and set queryDialect=skill_module. Then use servers_query_test.",
      parameters: {
        type: "object",
        properties: {
          slug: { type: "string" },
          queryConnectorSource: { type: "string" },
          queryGuide: { type: "string" },
        },
        required: ["slug", "queryConnectorSource"],
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




  const surface = mergeToolSurface(toolDefs, TOOL_SURFACE_OVERLAY);
  installToolSurface(surface);
  const toolByName = new Map(surface.map((d) => [d.name, d]));
  const tool = (name: string): ToolDefinition => {
    const def = toolByName.get(name);
    if (!def) throw new Error(`missing_tool_def: ${name}`);
    return toToolDefinition(def);
  };

  registerTool(tool("skill_list"), async () =>
    listSkills(skillRoots).map((s) => ({
      name: s.metadata.name,
      version: s.metadata.version,
      game: s.metadata.game,
      description: s.metadata.description,
      tags: s.metadata.tags,
      containerSupport: s.metadata.containerSupport,
      dockerImage: s.metadata.dockerImage,
      steamAppId: s.metadata.steamAppId,
      adminDialect: s.metadata.adminDialect,
      queryDialect: s.metadata.queryDialect,
      dependencies: s.metadata.dependencies,
      minRamMb: s.metadata.minRamMb,
      scope: s.path.includes(`${path.sep}servers${path.sep}`) ? "server" : "global",
    })),
  );

  registerTool(tool("skill_draft_save"), async (args) => {
    const saved = drafts.save({
      name: String(args.name),
      game: String(args.game),
      description: String(args.description),
      installGuide: String(args.installGuide),
      containerSupport: args.containerSupport as "full" | "partial" | "none" | undefined,
      warnings: args.warnings ? String(args.warnings) : undefined,
      queryConnectorSource: args.queryConnectorSource
        ? String(args.queryConnectorSource)
        : undefined,
      queryGuide: args.queryGuide ? String(args.queryGuide) : undefined,
    });
    return saved;
  });

  registerTool(tool("skill_draft_list"), async () => drafts.list());

  registerTool(tool("skill_promote"), async (args) => {
    return drafts.promote(String(args.slug));
  });

  registerTool(tool("servers_create_from_skill"), async (args) => {
    const skillName = String(args.skillName);
    const { server, mode } = await createOrReinstallFromSkill(servers, workspace, {
      skillName,
      serverName: args.serverName ? String(args.serverName) : undefined,
      nodeId: args.nodeId ? String(args.nodeId) : undefined,
    });
    await snapshots.create(server.id, "baseline");
    await playerPanel.publishForStatus(server.id, "stopped");
    const skill = loadSkillMetadata(skillRoots, skillName);
    if (skill?.metadata.watchers?.length) {
      try {
        await watchers.seedFromSkill(server.id, skill.metadata.name, skill.metadata.watchers);
      } catch {
        /* seeding is best-effort */
      }
    }
    const join = await servers.joinInfoFor(server);
    return {
      serverId: server.id,
      name: server.name,
      status: server.status,
      runtimeMode: server.runtimeMode,
      mode,
      join,
    };
  });

  registerTool(tool("servers_start"), async (args) => {
    const resolved = resolveWorkspaceServerId(args, workspace.serverId);
    if (!resolved.ok) return resolved.error;
    const server = await servers.start(resolved.serverId);
    const live = await safeQueryLive(
      (id) => queries.queryServerWithRetry(id, { attempts: 5, delayMs: 1200 }),
      server.id,
    );
    await playerPanel.publishForStatus(server.id, "running", live);
    const detail = await servers.detail(server.id);
    return {
      serverId: server.id,
      status: server.status,
      runtime: detail?.runtime,
      join: detail?.runtime.join,
      panelPublished: true,
      playerVisible: isPlayerPanelLiveStatus(server.status),
      liveOnline: live?.online ?? false,
    };
  });

  registerTool(tool("servers_stop"), async (args) => {
    const resolved = resolveWorkspaceServerId(args, workspace.serverId);
    if (!resolved.ok) return resolved.error;
    const server = await servers.stop(resolved.serverId);
    await playerPanel.publishForStatus(server.id, "stopped");
    return { serverId: server.id, status: server.status };
  });

  registerTool(tool("servers_restart"), async (args) => {
    const resolved = resolveWorkspaceServerId(args, workspace.serverId);
    if (!resolved.ok) return resolved.error;
    const server = await servers.restart(resolved.serverId);
    const live = await safeQueryLive(
      (id) => queries.queryServerWithRetry(id, { attempts: 5, delayMs: 1200 }),
      server.id,
    );
    await playerPanel.publishForStatus(server.id, "running", live);
    const detail = await servers.detail(server.id);
    return {
      serverId: server.id,
      status: server.status,
      runtime: detail?.runtime,
      join: detail?.runtime.join,
      liveOnline: live?.online ?? false,
    };
  });


  registerTool(tool("servers_list"), async () => {
    const rows = await servers.list();
    return rows.map((s) => ({
      id: s.id,
      name: s.name,
      game: s.game,
      status: s.status,
    }));
  });

  registerTool(tool("panel_publish"), async (args) => {
    const resolved = resolveOptionalWorkspaceServerId(args, workspace.serverId);
    if (!resolved.ok) return resolved.error;
    const blocks = Array.isArray(args.blocks) ? args.blocks : [];
    return playerPanel.publishFromAgent(resolved.serverId, blocks);
  });

  registerTool(tool("panel_list"), async (args) => {
    const resolved = resolveOptionalWorkspaceServerId(args, workspace.serverId);
    if (!resolved.ok) return resolved.error;
    return panel.list(resolved.serverId);
  });

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

  registerTool(tool("fs_list"), async (args) => {
    const resolved = resolveWorkspaceServerId(args, workspace.serverId);
    if (!resolved.ok) return resolved.error;
    return serverFs.list(resolved.serverId, args.path ? String(args.path) : ".");
  });

  registerTool(tool("fs_read"), async (args) => {
    const resolved = resolveWorkspaceServerId(args, workspace.serverId);
    if (!resolved.ok) return resolved.error;
    return serverFs.read(resolved.serverId, String(args.path), {
      offset: args.offset !== undefined ? Number(args.offset) : undefined,
      maxBytes: args.maxBytes !== undefined ? Number(args.maxBytes) : undefined,
    });
  });

  registerTool(tool("fs_write"), async (args) => {
    const resolved = resolveWorkspaceServerId(args, workspace.serverId);
    if (!resolved.ok) return resolved.error;
    return serverFs.write(resolved.serverId, String(args.path), String(args.content));
  });

  registerTool(tool("fs_delete"), async (args) => {
    const resolved = resolveWorkspaceServerId(args, workspace.serverId);
    if (!resolved.ok) return resolved.error;
    return serverFs.delete(resolved.serverId, String(args.path));
  });

  registerTool(tool("fs_rename"), async (args) => {
    const resolved = resolveWorkspaceServerId(args, workspace.serverId);
    if (!resolved.ok) return resolved.error;
    return serverFs.rename(resolved.serverId, String(args.from), String(args.to), {
      overwrite: Boolean(args.overwrite),
    });
  });

  registerTool(tool("fs_copy"), async (args) => {
    const resolved = resolveWorkspaceServerId(args, workspace.serverId);
    if (!resolved.ok) return resolved.error;
    return serverFs.copy(resolved.serverId, String(args.from), String(args.to), {
      overwrite: Boolean(args.overwrite),
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

  registerTool(tool("net_port_check"), async (args) =>
    net.portCheck({
      host: args.host ? String(args.host) : undefined,
      port: Number(args.port),
    }),
  );

  registerTool(tool("net_suggest_bind"), async (args) =>
    net.suggestBind({
      preferredPort: args.preferredPort !== undefined ? Number(args.preferredPort) : undefined,
      host: args.host ? String(args.host) : undefined,
    }),
  );

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

  registerTool(tool("servers_health_check"), async (args) => {
    const resolved = resolveWorkspaceServerId(args, workspace.serverId);
    if (!resolved.ok) return resolved.error;
    return health.checkServer(resolved.serverId, {
      remediate: Boolean(args.remediate),
    });
  });

  registerTool(tool("skill_read"), async (args) => {
    const skillName = String(args.skillName);
    const entry = listSkills(skillRoots).find((s) => s.metadata.name === skillName);
    if (!entry) return { error: `unknown_skill: ${skillName}` };
    const guideName = args.guide ? String(args.guide) : "INSTALL.md";
    const safe = path.basename(guideName);
    const guidePath = path.join(entry.path, "guides", safe);
    if (!fs.existsSync(guidePath)) {
      const guidesDir = path.join(entry.path, "guides");
      const available = fs.existsSync(guidesDir)
        ? fs.readdirSync(guidesDir).filter((f) => f.endsWith(".md"))
        : [];
      return { error: `guide_not_found: ${safe}`, skillName, availableGuides: available };
    }
    return {
      skillName,
      guide: safe,
      path: guidePath,
      content: fs.readFileSync(guidePath, "utf8"),
      metadata: {
        version: entry.metadata.version,
        dependencies: entry.metadata.dependencies,
        dockerImage: entry.metadata.dockerImage,
        steamAppId: entry.metadata.steamAppId,
        adminDialect: entry.metadata.adminDialect,
        containerSupport: entry.metadata.containerSupport,
      },
    };
  });

  registerTool(tool("skill_export"), async (args) => {
    const exported = skillPackages.exportZip(String(args.skillName));
    const exportsDir = path.join(config.dataRoot, "exports");
    fs.mkdirSync(exportsDir, { recursive: true });
    const outPath = path.join(exportsDir, exported.filename);
    fs.writeFileSync(outPath, exported.bytes);
    return {
      skillName: exported.metadataName,
      filename: exported.filename,
      path: outPath,
      bytes: exported.bytes.byteLength,
    };
  });

  registerTool(tool("skill_import"), async (args) => {
    const zipPath = path.resolve(String(args.zipPath));
    const root = path.resolve(config.dataRoot);
    if (zipPath !== root && !zipPath.startsWith(root + path.sep)) {
      throw new Error("zip_path_outside_data_root");
    }
    const bytes = new Uint8Array(fs.readFileSync(zipPath));
    return skillPackages.importZip(bytes, { overwrite: Boolean(args.overwrite) });
  });

  registerTool(tool("skill_search"), async (args) => {
    const url = await catalogUrl();
    const q = args.query !== undefined ? String(args.query) : "";
    try {
      const skills = annotateCatalogInstalled(
        searchCatalog(await fetchSkillsCatalog(url), q),
        config.skillsRoots,
      );
      return {
        catalogUrl: url,
        skills: skills.map((s) => ({
          name: s.name,
          version: s.version,
          game: s.game,
          description: s.description,
          tags: s.tags,
          dependencies: s.dependencies,
          containerSupport: s.containerSupport,
          minRamMb: s.minRamMb,
          downloadUrl: s.downloadUrl,
          sha256: s.sha256,
          official: s.official,
          installed: s.installed,
        })),
      };
    } catch (err) {
      return {
        catalogUrl: url,
        skills: [],
        error: err instanceof Error ? err.message : "catalog_unavailable",
      };
    }
  });

  registerTool(tool("skill_install_url"), async (args) => {
    const name = args.name !== undefined ? String(args.name).trim() : "";
    const downloadUrl = args.downloadUrl !== undefined ? String(args.downloadUrl).trim() : "";
    const url = await catalogUrl();
    return installSkillFromCatalog({
      config,
      skillPackages,
      catalogUrl: url,
      name: name || undefined,
      downloadUrl: downloadUrl || undefined,
      overwrite: Boolean(args.overwrite),
    });
  });

  registerTool(tool("skill_promote_server"), async (args) => {
    const resolved = resolveWorkspaceServerId(args, workspace.serverId);
    if (!resolved.ok) return resolved.error;
    return skillPackages.promoteServerSkill(resolved.serverId, String(args.skillSlug), {
      overwrite: Boolean(args.overwrite),
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

  registerTool(tool("servers_relocate"), async (args) => {
    const resolved = resolveWorkspaceServerId(args, workspace.serverId);
    if (!resolved.ok) return resolved.error;
    return migrate.relocate(resolved.serverId, String(args.targetNodeId));
  });

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

  registerTool(tool("servers_import_local"), async (args) => {
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
  });

  registerTool(tool("servers_import_sftp"), async (args) => {
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

  registerTool(tool("node_ping"), async (args) => {
    const nodeId = String(args.nodeId);
    const job = nodeJobService.enqueue(nodeId, "ping", {});
    try {
      const done = await nodeJobService.waitFor(job.id, { timeoutMs: 20_000 });
      if (done.status === "failed") return { error: done.error ?? "node_job_failed", jobId: job.id };
      return { jobId: job.id, nodeId, result: done.result };
    } catch (err) {
      return { error: err instanceof Error ? err.message : "node_job_timeout", jobId: job.id };
    }
  });

  registerTool(tool("node_fs_list"), async (args) => {
    const nodeId = String(args.nodeId);
    const job = nodeJobService.enqueue(nodeId, "fs_list", {
      path: args.path ? String(args.path) : ".",
    });
    try {
      const done = await nodeJobService.waitFor(job.id, { timeoutMs: 20_000 });
      if (done.status === "failed") return { error: done.error ?? "node_job_failed", jobId: job.id };
      return { jobId: job.id, nodeId, result: done.result };
    } catch (err) {
      return { error: err instanceof Error ? err.message : "node_job_timeout", jobId: job.id };
    }
  });

  registerTool(tool("servers_delete"), async (args) => {
    const resolved = resolveWorkspaceServerId(args, workspace.serverId);
    if (!resolved.ok) return resolved.error;
    const removed = await servers.remove(resolved.serverId);
    await panel.clearForServer(removed.id);
    return { ok: true, removed };
  });

  registerTool(tool("servers_logs_tail"), async (args) => {
    const resolved = resolveWorkspaceServerId(args, workspace.serverId);
    if (!resolved.ok) return resolved.error;
    const requested = args.lines !== undefined ? Number(args.lines) : 80;
    const lineCount = Number.isFinite(requested) ? requested : 80;
    const result = await servers.tailLogs(resolved.serverId, lineCount);
    if (!result) return { error: `unknown_server: ${resolved.serverId}` };
    return { serverId: resolved.serverId, ...result };
  });

  registerTool(tool("servers_query"), async (args) => {
    const resolved = resolveWorkspaceServerId(args, workspace.serverId);
    if (!resolved.ok) return resolved.error;
    const state = await queries.queryServer(resolved.serverId);
    if (state.online) {
      const server = await servers.get(resolved.serverId);
      if (server && (server.status === "running" || server.status === "starting")) {
        try {
          await playerPanel.publishForStatus(
            resolved.serverId,
            server.status === "starting" ? "starting" : "running",
            state,
          );
        } catch {
          /* panel refresh best-effort */
        }
      }
    }
    return { serverId: resolved.serverId, ...state };
  });

  registerTool(tool("servers_query_test"), async (args) => {
    return queries.queryTest({
      host: String(args.host ?? "127.0.0.1"),
      port: Number(args.port),
      queryPort: args.queryPort !== undefined ? Number(args.queryPort) : undefined,
      gamePort: args.gamePort !== undefined ? Number(args.gamePort) : undefined,
      skillName: args.skillName ? String(args.skillName) : undefined,
      connectorPath: args.connectorPath ? String(args.connectorPath) : undefined,
      queryDialect: args.queryDialect as QueryDialect | undefined,
      timeoutMs: args.timeoutMs !== undefined ? Number(args.timeoutMs) : undefined,
    });
  });

  registerTool(tool("skill_draft_set_query_connector"), async (args) => {
    return drafts.setQueryConnector(
      String(args.slug),
      String(args.queryConnectorSource),
      args.queryGuide ? String(args.queryGuide) : undefined,
    );
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

  return {
    getDefinitions: () => [...tools.values()].map((t) => t.def),
    parityFingerprint: () =>
      [...tools.values()]
        .map((t) => ({
          name: t.def.name,
          requiresConfirm: Boolean(t.def.requiresConfirm),
        }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    registerInto(orchestrator: Orchestrator) {
      for (const { def, handler } of tools.values()) {
        orchestrator.registerTool(def, handler);
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
  const registry = createPlayOnToolRegistry(plane, {
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
