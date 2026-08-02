import fs from "node:fs";
import path from "node:path";
import type { ChatStreamSink, ConfirmGate, ToolDefinition } from "@playon/agent-core";
import { Orchestrator } from "@playon/agent-core";
import { OpenAICompatibleLlmClient, type LlmClient } from "@playon/agent-core";
import { PanelBlockTypeSchema } from "@playon/shared";
import type { AppConfig } from "../config.js";
import type { Db } from "../db/client.js";
import { decryptSecret } from "./secrets.js";
import { getSetting, LLM_SETTINGS_KEY, type LlmSettings } from "./settings.js";
import type { EventHub } from "./event-hub.js";
import { ServerArchiveService } from "./archive-tools.js";
import { ServerFsService } from "./fs-tools.js";
import { NetToolsService } from "./net-tools.js";
import { listSkills, skillsRootsForWorkspace } from "./skills.js";
import { SkillDraftService } from "./skill-drafts.js";
import { SkillPackageService } from "./skill-packages.js";
import { MigrateService } from "./migrate.js";
import { ImportLocalService } from "./import-local.js";
import { ImportSftpService } from "./import-sftp.js";
import { OffNodeBackupService } from "./offnode-backup.js";
import { PlacementService } from "./placement.js";
import { HealthService } from "./health.js";
import { nodeJobService } from "./node-jobs.js";
import { PanelService } from "./panel.js";
import { rconExec, rconExecWithSelfHeal } from "./rcon.js";
import {
  clientSetupNotes,
  enrichBlocksWithLiveStatus,
  enrichJoinInfoBody,
  isPlayerPanelLiveStatus,
  publishServerPanel,
  resolveJoin,
  safeQueryLive,
} from "./server-panel.js";
import { ServerQueryService } from "./server-query.js";
import { ServerService } from "./servers.js";
import { SnapshotService, withSnapshot } from "./snapshots.js";
import { SteamcmdNotFoundError, steamcmdAppUpdate } from "./steamcmd.js";




/** Map common LLM aliases to canonical panel block types. */
export function normalizePanelBlockType(raw: unknown): string {
  const value = String(raw ?? "")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
  const aliases: Record<string, string> = {
    status: "server_status",
    serverstatus: "server_status",
    state: "server_status",
    join: "join_info",
    joininfo: "join_info",
    connection: "join_info",
    connect: "join_info",
    setup: "client_setup",
    clientsetup: "client_setup",
    client: "client_setup",
    howto: "guide",
    how_to: "guide",
    instructions: "guide",
    poll: "vote",
    voting: "vote",
    ready: "readiness",
    announcement: "announcement",
    announce: "announcement",
    news: "announcement",
    file: "file_drop",
    files: "file_drop",
    download: "file_drop",
    discover: "discovery",
  };
  return aliases[value] ?? value;
}

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

const VENICE_BASE_URL = "https://api.venice.ai/api/v1";
const VENICE_DEFAULT_MODEL = "llama-3.3-70b";

export async function createLlmClient(
  db: Db,
  config: AppConfig,
): Promise<LlmClient> {
  const stored = await getSetting<LlmSettings>(db, LLM_SETTINGS_KEY);
  const provider =
    stored?.provider === "ollama" || stored?.provider === "openai_compatible"
      ? stored.provider
      : config.llmMode;

  const envVenice =
    process.env.PLAYON_VENICE_API_KEY?.trim() || process.env.VENICE_API_KEY?.trim() || "";

  const storedKey = (): string => {
    if (!stored?.apiKeyEncrypted) return "";
    try {
      return decryptSecret(config.sessionSecret, stored.apiKeyEncrypted);
    } catch {
      // Session secret rotated (common after prod install) — fall back to env.
      return "";
    }
  };

  if (provider === "ollama") {
    return new OpenAICompatibleLlmClient(
      stored?.baseUrl ?? "http://127.0.0.1:11434/v1",
      storedKey() || envVenice,
      stored?.model ?? "llama3.2",
      "ollama",
    );
  }

  const apiKey = storedKey() || envVenice;
  if (!apiKey) {
    throw new Error(
      "llm_api_key_required: set a Venice API key under Settings → Model, or PLAYON_VENICE_API_KEY (re-save the key if PLAYON_SESSION_SECRET changed)",
    );
  }
  return new OpenAICompatibleLlmClient(
    stored?.baseUrl ?? VENICE_BASE_URL,
    apiKey,
    stored?.model ?? VENICE_DEFAULT_MODEL,
    "openai_compatible",
  );
}

export function createOrchestrator(
  db: Db,
  config: AppConfig,
  llm: LlmClient,
  options: {
    confirmGate?: ConfirmGate;
    stream?: ChatStreamSink;
    eventHub?: EventHub;
    workspaceServerId?: string;
  } = {},
): Orchestrator {
  /** Binds on first create/import so mid-turn sibling creates cannot fork. */
  const workspace: WorkspaceBinding = { serverId: options.workspaceServerId };
  const skillRoots = skillsRootsForWorkspace(
    config.skillsRoots,
    config.dataRoot,
    workspace.serverId,
  );
  const servers = new ServerService(db, config, options.eventHub);
  const snapshots = new SnapshotService(db, config, servers);
  const serverFs = new ServerFsService(servers);
  const archives = new ServerArchiveService(servers);
  const net = new NetToolsService(servers);
  const drafts = new SkillDraftService(config);
  const skillPackages = new SkillPackageService(config);
  const placement = new PlacementService(db, config, net);
  const migrate = new MigrateService(db, servers, snapshots, placement, options.eventHub);
  const offNode = new OffNodeBackupService(db, config, snapshots);
  const importLocal = new ImportLocalService(db, config, servers, snapshots);
  const importSftp = new ImportSftpService(db, config, servers, snapshots);
  const panel = new PanelService(db, options.eventHub);
  const queries = new ServerQueryService(servers, config);
  const health = new HealthService(servers, net, config, queries);
  const orch = new Orchestrator(llm, {
    confirmGate: options.confirmGate,
    stream: options.stream,
    workspaceServerId: workspace.serverId,
  });



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
        "Read guides/*.md (and optional path) from an installed skill so you can follow INSTALL steps. Prefer this before drafting a new skill.",
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
        "Rank nodes for a skill by OS, Docker, disk, and online status. Use before servers_create_from_skill when choosing nodeId.",
      parameters: {
        type: "object",
        properties: { skillName: { type: "string" } },
        required: ["skillName"],
      },
    },
    {
      name: "servers_relocate",
      description:
        "Best-effort move a server onto another node: stop, snapshot, rebind nodeId, restart on the control plane.",
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
            enum: [
              "none",
              "minecraft_status",
              "a2s",
              "valheim",
              "unreal",
              "terraria",
              "factorio",
              "skill_module",
            ],
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
  ];




  const toolByName = new Map(toolDefs.map((d) => [d.name, d]));
  const tool = (name: string): ToolDefinition => {
    const def = toolByName.get(name);
    if (!def) throw new Error(`missing_tool_def: ${name}`);
    return def;
  };

  orch.registerTool(tool("skill_list"), async () =>
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

  orch.registerTool(tool("skill_draft_save"), async (args) => {
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

  orch.registerTool(tool("skill_draft_list"), async () => drafts.list());

  orch.registerTool(tool("skill_promote"), async (args) => {
    return drafts.promote(String(args.slug));
  });

  orch.registerTool(tool("servers_create_from_skill"), async (args) => {
    const { server, mode } = await createOrReinstallFromSkill(servers, workspace, {
      skillName: String(args.skillName),
      serverName: args.serverName ? String(args.serverName) : undefined,
      nodeId: args.nodeId ? String(args.nodeId) : undefined,
    });
    await snapshots.create(server.id, "baseline");
    await publishServerPanel(servers, panel, server.id, "stopped");
    const join = servers.joinInfoFor(server);
    return {
      serverId: server.id,
      name: server.name,
      status: server.status,
      runtimeMode: server.runtimeMode,
      mode,
      join,
    };
  });

  orch.registerTool(tool("servers_start"), async (args) => {
    const resolved = resolveWorkspaceServerId(args, workspace.serverId);
    if (!resolved.ok) return resolved.error;
    const server = await servers.start(resolved.serverId);
    const live = await safeQueryLive(
      (id) => queries.queryServerWithRetry(id, { attempts: 5, delayMs: 1200 }),
      server.id,
    );
    await publishServerPanel(servers, panel, server.id, "running", live);
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

  orch.registerTool(tool("servers_stop"), async (args) => {
    const resolved = resolveWorkspaceServerId(args, workspace.serverId);
    if (!resolved.ok) return resolved.error;
    const server = await servers.stop(resolved.serverId);
    await publishServerPanel(servers, panel, server.id, "stopped");
    return { serverId: server.id, status: server.status };
  });

  orch.registerTool(tool("servers_restart"), async (args) => {
    const resolved = resolveWorkspaceServerId(args, workspace.serverId);
    if (!resolved.ok) return resolved.error;
    const server = await servers.restart(resolved.serverId);
    const live = await safeQueryLive(
      (id) => queries.queryServerWithRetry(id, { attempts: 5, delayMs: 1200 }),
      server.id,
    );
    await publishServerPanel(servers, panel, server.id, "running", live);
    const detail = await servers.detail(server.id);
    return {
      serverId: server.id,
      status: server.status,
      runtime: detail?.runtime,
      join: detail?.runtime.join,
      liveOnline: live?.online ?? false,
    };
  });


  orch.registerTool(tool("servers_list"), async () => {
    const rows = await servers.list();
    return rows.map((s) => ({
      id: s.id,
      name: s.name,
      game: s.game,
      status: s.status,
    }));
  });

  orch.registerTool(tool("panel_publish"), async (args) => {
    const resolved = resolveOptionalWorkspaceServerId(args, workspace.serverId);
    if (!resolved.ok) return resolved.error;
    const blocks = Array.isArray(args.blocks) ? args.blocks : [];
    let parsedBlocks = blocks.map((block, index) => {
      const raw = block as Record<string, unknown>;
      return {
        type: PanelBlockTypeSchema.parse(normalizePanelBlockType(raw.type)),
        title: String(raw.title),
        body: (raw.body as Record<string, unknown> | undefined) ?? {},
        sortOrder: typeof raw.sortOrder === "number" ? raw.sortOrder : index,
      };
    });
    // Prefer control-plane join (advertise host + skill port) over LLM-invented ports.
    // Preserve agent connectCommand / steamConnectUrl; fill game defaults when missing.
    let serverStatus: string | undefined;
    if (resolved.serverId) {
      const detail = await servers.detail(resolved.serverId);
      serverStatus = detail?.server.status;
      const join = detail?.runtime.join;
      if (join && detail) {
        const joinMeta = resolveJoin(servers, detail.server.dataPath);
        const existing = await panel.list(resolved.serverId);
        const previousStatusBody =
          existing.find((b) => b.type === "server_status")?.body ?? null;
        const live = isPlayerPanelLiveStatus(detail.server.status)
          ? await safeQueryLive(
              (id) => queries.queryServerWithRetry(id, { attempts: 3, delayMs: 800 }),
              resolved.serverId,
            )
          : null;
        parsedBlocks = parsedBlocks.map((block) => {
          if (block.type === "join_info") {
            return {
              ...block,
              body: enrichJoinInfoBody({
                body: block.body,
                address: join.address,
                port: join.port,
                join: joinMeta,
                game: detail.server.game,
              }),
            };
          }
          return block;
        });
        // Agents sometimes omit join_info — inject control-plane join so players are never blank.
        if (!parsedBlocks.some((b) => b.type === "join_info")) {
          parsedBlocks.unshift({
            type: "join_info",
            title: detail.server.game ? `Join ${detail.server.game}` : "Join",
            body: enrichJoinInfoBody({
              body: {},
              address: join.address,
              port: join.port,
              join: joinMeta,
              game: detail.server.game,
            }),
            sortOrder: -1,
          });
        }
        if (!parsedBlocks.some((b) => b.type === "client_setup")) {
          parsedBlocks.push({
            type: "client_setup",
            title: "How to connect",
            body: {
              notes: clientSetupNotes({
                join: joinMeta,
                address: join.address,
                port: join.port,
              }),
            },
            sortOrder: parsedBlocks.length,
          });
        }
        // Live query fields are control-plane owned — merge/inject so agents cannot wipe them.
        parsedBlocks = enrichBlocksWithLiveStatus(parsedBlocks, {
          status: detail.server.status,
          runtime: detail.runtime.kind,
          game: detail.server.game,
          live,
          previousStatusBody,
        });
      }
      const published = await panel.replaceForServer(resolved.serverId, parsedBlocks);
      const playerVisible = isPlayerPanelLiveStatus(serverStatus);
      return {
        published: published.length,
        blocks: published,
        mode: "replace",
        playerVisible,
        serverStatus,
        hint: playerVisible
          ? undefined
          : "Blocks saved, but the public player panel only shows join info while the server is starting or running. Call servers_start (or wait for start) so players can see it.",
      };
    }
    const published = await panel.publish({
      serverId: resolved.serverId,
      blocks: parsedBlocks,
    });
    return {
      published: published.length,
      blocks: published,
      mode: "append",
      playerVisible: true,
    };
  });

  orch.registerTool(tool("panel_list"), async (args) => {
    const resolved = resolveOptionalWorkspaceServerId(args, workspace.serverId);
    if (!resolved.ok) return resolved.error;
    return panel.list(resolved.serverId);
  });

  orch.registerTool(tool("snapshot_create"), async (args) => {
    const resolved = resolveWorkspaceServerId(args, workspace.serverId);
    if (!resolved.ok) return resolved.error;
    const label = args.label ? String(args.label) : `snapshot-${Date.now()}`;
    const snapshot = await snapshots.create(resolved.serverId, label);
    return { snapshotId: snapshot.id, label: snapshot.label, path: snapshot.path };
  });

  orch.registerTool(tool("snapshot_restore"), async (args) => {
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

  orch.registerTool(tool("snapshot_list"), async (args) => {
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

  orch.registerTool(tool("snapshot_enforce_retention"), async (args) => {
    const resolved = resolveOptionalWorkspaceServerId(args, workspace.serverId);
    if (!resolved.ok) return resolved.error;
    return snapshots.enforceRetention(resolved.serverId, {
      maxCount: args.maxCount !== undefined ? Number(args.maxCount) : 10,
      maxAgeHours: args.maxAgeHours !== undefined ? Number(args.maxAgeHours) : 72,
    });
  });

  orch.registerTool(tool("fs_list"), async (args) => {
    const resolved = resolveWorkspaceServerId(args, workspace.serverId);
    if (!resolved.ok) return resolved.error;
    return serverFs.list(resolved.serverId, args.path ? String(args.path) : ".");
  });

  orch.registerTool(tool("fs_read"), async (args) => {
    const resolved = resolveWorkspaceServerId(args, workspace.serverId);
    if (!resolved.ok) return resolved.error;
    return serverFs.read(resolved.serverId, String(args.path), {
      offset: args.offset !== undefined ? Number(args.offset) : undefined,
      maxBytes: args.maxBytes !== undefined ? Number(args.maxBytes) : undefined,
    });
  });

  orch.registerTool(tool("fs_write"), async (args) => {
    const resolved = resolveWorkspaceServerId(args, workspace.serverId);
    if (!resolved.ok) return resolved.error;
    return serverFs.write(resolved.serverId, String(args.path), String(args.content));
  });

  orch.registerTool(tool("fs_delete"), async (args) => {
    const resolved = resolveWorkspaceServerId(args, workspace.serverId);
    if (!resolved.ok) return resolved.error;
    return serverFs.delete(resolved.serverId, String(args.path));
  });

  orch.registerTool(tool("fs_rename"), async (args) => {
    const resolved = resolveWorkspaceServerId(args, workspace.serverId);
    if (!resolved.ok) return resolved.error;
    return serverFs.rename(resolved.serverId, String(args.from), String(args.to), {
      overwrite: Boolean(args.overwrite),
    });
  });

  orch.registerTool(tool("fs_copy"), async (args) => {
    const resolved = resolveWorkspaceServerId(args, workspace.serverId);
    if (!resolved.ok) return resolved.error;
    return serverFs.copy(resolved.serverId, String(args.from), String(args.to), {
      overwrite: Boolean(args.overwrite),
    });
  });

  orch.registerTool(tool("archive_extract"), async (args) => {
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

  orch.registerTool(tool("net_port_check"), async (args) =>
    net.portCheck({
      host: args.host ? String(args.host) : undefined,
      port: Number(args.port),
    }),
  );

  orch.registerTool(tool("net_suggest_bind"), async (args) =>
    net.suggestBind({
      preferredPort: args.preferredPort !== undefined ? Number(args.preferredPort) : undefined,
      host: args.host ? String(args.host) : undefined,
    }),
  );

  orch.registerTool(tool("fetch_url"), async (args) => {
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

  orch.registerTool(tool("servers_health_check"), async (args) => {
    const resolved = resolveWorkspaceServerId(args, workspace.serverId);
    if (!resolved.ok) return resolved.error;
    return health.checkServer(resolved.serverId, {
      remediate: Boolean(args.remediate),
    });
  });

  orch.registerTool(tool("skill_read"), async (args) => {
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

  orch.registerTool(tool("skill_export"), async (args) => {
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

  orch.registerTool(tool("skill_import"), async (args) => {
    const zipPath = path.resolve(String(args.zipPath));
    const root = path.resolve(config.dataRoot);
    if (zipPath !== root && !zipPath.startsWith(root + path.sep)) {
      throw new Error("zip_path_outside_data_root");
    }
    const bytes = new Uint8Array(fs.readFileSync(zipPath));
    return skillPackages.importZip(bytes, { overwrite: Boolean(args.overwrite) });
  });

  orch.registerTool(tool("skill_promote_server"), async (args) => {
    const resolved = resolveWorkspaceServerId(args, workspace.serverId);
    if (!resolved.ok) return resolved.error;
    return skillPackages.promoteServerSkill(resolved.serverId, String(args.skillSlug), {
      overwrite: Boolean(args.overwrite),
    });
  });

  orch.registerTool(tool("placement_suggest"), async (args) => placement.plan(String(args.skillName)));

  orch.registerTool(tool("servers_relocate"), async (args) => {
    const resolved = resolveWorkspaceServerId(args, workspace.serverId);
    if (!resolved.ok) return resolved.error;
    return migrate.relocate(resolved.serverId, String(args.targetNodeId));
  });

  orch.registerTool(tool("backup_offnode"), async (args) => {
    const resolved = resolveWorkspaceServerId(args, workspace.serverId);
    if (!resolved.ok) return resolved.error;
    return offNode.backupServer(
      resolved.serverId,
      args.label ? String(args.label) : undefined,
    );
  });

  orch.registerTool(tool("backup_offnode_list"), async (args) => {
    const resolved = resolveOptionalWorkspaceServerId(args, workspace.serverId);
    if (!resolved.ok) return resolved.error;
    return offNode.list(resolved.serverId);
  });

  orch.registerTool(tool("backup_offnode_restore"), async (args) => {
    const resolved = resolveOptionalWorkspaceServerId(args, workspace.serverId);
    if (!resolved.ok) return resolved.error;
    return offNode.restore(String(args.backupId), resolved.serverId);
  });

  orch.registerTool(tool("servers_import_local"), async (args) => {
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

  orch.registerTool(tool("servers_import_sftp"), async (args) => {
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

  orch.registerTool(tool("rcon_exec"), async (args) => {
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

  orch.registerTool(tool("rcon_say"), async (args) => {
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

  orch.registerTool(tool("steamcmd_app_update"), async (args) => {
    const resolved = resolveWorkspaceServerId(args, workspace.serverId);
    if (!resolved.ok) return resolved.error;
    const server = await servers.get(resolved.serverId);
    if (!server) return { error: `unknown_server: ${resolved.serverId}` };
    try {
      const result = await steamcmdAppUpdate({
        serverDataPath: server.dataPath,
        appId: Number(args.appId),
        installDirRel: args.installDir ? String(args.installDir) : undefined,
        validate: args.validate === undefined ? true : Boolean(args.validate),
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

  orch.registerTool(tool("node_ping"), async (args) => {
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

  orch.registerTool(tool("node_fs_list"), async (args) => {
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

  orch.registerTool(tool("servers_delete"), async (args) => {
    const resolved = resolveWorkspaceServerId(args, workspace.serverId);
    if (!resolved.ok) return resolved.error;
    const removed = await servers.remove(resolved.serverId);
    await panel.clearForServer(removed.id);
    return { ok: true, removed };
  });

  orch.registerTool(tool("servers_logs_tail"), async (args) => {
    const resolved = resolveWorkspaceServerId(args, workspace.serverId);
    if (!resolved.ok) return resolved.error;
    const requested = args.lines !== undefined ? Number(args.lines) : 80;
    const lineCount = Number.isFinite(requested) ? requested : 80;
    const result = await servers.tailLogs(resolved.serverId, lineCount);
    if (!result) return { error: `unknown_server: ${resolved.serverId}` };
    return { serverId: resolved.serverId, ...result };
  });

  orch.registerTool(tool("servers_query"), async (args) => {
    const resolved = resolveWorkspaceServerId(args, workspace.serverId);
    if (!resolved.ok) return resolved.error;
    const state = await queries.queryServer(resolved.serverId);
    if (state.online) {
      const server = await servers.get(resolved.serverId);
      if (server && (server.status === "running" || server.status === "starting")) {
        try {
          await publishServerPanel(
            servers,
            panel,
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

  orch.registerTool(tool("servers_query_test"), async (args) => {
    return queries.queryTest({
      host: String(args.host ?? "127.0.0.1"),
      port: Number(args.port),
      queryPort: args.queryPort !== undefined ? Number(args.queryPort) : undefined,
      gamePort: args.gamePort !== undefined ? Number(args.gamePort) : undefined,
      skillName: args.skillName ? String(args.skillName) : undefined,
      connectorPath: args.connectorPath ? String(args.connectorPath) : undefined,
      queryDialect: args.queryDialect as
        | "none"
        | "minecraft_status"
        | "a2s"
        | "valheim"
        | "unreal"
        | "terraria"
        | "factorio"
        | "skill_module"
        | undefined,
      timeoutMs: args.timeoutMs !== undefined ? Number(args.timeoutMs) : undefined,
    });
  });

  orch.registerTool(tool("skill_draft_set_query_connector"), async (args) => {
    return drafts.setQueryConnector(
      String(args.slug),
      String(args.queryConnectorSource),
      args.queryGuide ? String(args.queryGuide) : undefined,
    );
  });

  return orch;
}



// Re-export for callers that need direct snapshot access in tests or future routes.
export { SnapshotService, withSnapshot };
