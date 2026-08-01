import fs from "node:fs";
import path from "node:path";
import type { ChatStreamSink, ConfirmGate, ToolDefinition } from "@playon/agent-core";
import { Orchestrator } from "@playon/agent-core";
import {
  IntentMockLlmClient,
  OpenAICompatibleLlmClient,
  type LlmClient,
} from "@playon/agent-core";
import { PanelBlockTypeSchema } from "@playon/shared";
import type { AppConfig } from "../config.js";
import type { Db } from "../db/client.js";
import { decryptSecret } from "./secrets.js";
import { getSetting, LLM_SETTINGS_KEY, type LlmSettings } from "./settings.js";
import type { EventHub } from "./event-hub.js";
import { ServerFsService } from "./fs-tools.js";
import { NetToolsService } from "./net-tools.js";
import { listSkills } from "./skills.js";
import { SkillDraftService } from "./skill-drafts.js";
import { SkillPackageService } from "./skill-packages.js";
import { MigrateService } from "./migrate.js";
import { ImportLocalService } from "./import-local.js";
import { ImportSftpService } from "./import-sftp.js";
import { OffNodeBackupService } from "./offnode-backup.js";
import { PlacementService } from "./placement.js";
import { HealthService } from "./health.js";
import { PanelService } from "./panel.js";
import { publishServerPanel } from "./server-panel.js";
import { ServerService } from "./servers.js";
import { SnapshotService, withSnapshot } from "./snapshots.js";




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

export async function createLlmClient(
  db: Db,
  config: AppConfig,
): Promise<LlmClient> {
  const stored = await getSetting<LlmSettings>(db, LLM_SETTINGS_KEY);
  const provider = stored?.provider ?? config.llmMode;

  if (provider === "mock") {
    return new IntentMockLlmClient();
  }

  if (provider === "ollama") {
    return new OpenAICompatibleLlmClient(
      stored?.baseUrl ?? "http://127.0.0.1:11434/v1",
      stored?.apiKeyEncrypted ? decryptSecret(config.sessionSecret, stored.apiKeyEncrypted) : "",
      stored?.model ?? "llama3.2",
      "ollama",
    );
  }

  if (provider === "openai_compatible") {
    const baseUrl = stored?.baseUrl ?? "https://api.openai.com/v1";
    const model = stored?.model ?? "gpt-4o-mini";
    const apiKey = stored?.apiKeyEncrypted
      ? decryptSecret(config.sessionSecret, stored.apiKeyEncrypted)
      : "";
    return new OpenAICompatibleLlmClient(baseUrl, apiKey, model, "openai_compatible");
  }

  return new IntentMockLlmClient();
}

export function createOrchestrator(
  db: Db,
  config: AppConfig,
  llm: LlmClient,
  options: {
    confirmGate?: ConfirmGate;
    stream?: ChatStreamSink;
    eventHub?: EventHub;
  } = {},
): Orchestrator {
  const servers = new ServerService(db, config, options.eventHub);
  const snapshots = new SnapshotService(db, config, servers);
  const serverFs = new ServerFsService(servers);
  const net = new NetToolsService(servers);
  const drafts = new SkillDraftService(config);
  const skillPackages = new SkillPackageService(config);
  const placement = new PlacementService(db, config, net);
  const migrate = new MigrateService(db, servers, snapshots, placement, options.eventHub);
  const offNode = new OffNodeBackupService(db, config, snapshots);
  const importLocal = new ImportLocalService(db, config, servers, snapshots);
  const importSftp = new ImportSftpService(db, config, servers, snapshots);
  const panel = new PanelService(db, options.eventHub);
  const health = new HealthService(servers, net, config);
  const orch = new Orchestrator(llm, {
    confirmGate: options.confirmGate,
    stream: options.stream,
  });



  // Tool names must match ^[a-zA-Z0-9_-]+$ for Venice / many OpenAI-compatible gateways.
  const toolDefs: ToolDefinition[] = [
    {
      name: "skill_list",
      description: "List installable skills",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
    {
      name: "skill_draft_save",
      description: "Save a draft skill for later promotion",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string" },
          game: { type: "string" },
          description: { type: "string" },
          installGuide: { type: "string" },
          containerSupport: { type: "string", enum: ["full", "partial", "none"] },
          warnings: { type: "string" },
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
      description: "Create a server from a skill",
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
        "Publish player panel blocks. Each block.type MUST be one of: server_status, join_info, client_setup, guide, vote, readiness, announcement, file_drop, discovery (not short aliases like status).",
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
                body: { type: "object" },
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
      description: "Read a text file under a server data directory (path-jailed)",
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
      description: "Download an HTTP(S) URL into a path under a server data directory (jailed)",
      parameters: {
        type: "object",
        properties: {
          serverId: { type: "string" },
          url: { type: "string" },
          destPath: { type: "string" },
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
  ];



  orch.registerTool(toolDefs[0]!, async () =>
    listSkills(config.skillsRoots).map((s) => ({
      name: s.metadata.name,
      version: s.metadata.version,
      game: s.metadata.game,
      description: s.metadata.description,
      tags: s.metadata.tags,
    })),
  );

  orch.registerTool(toolDefs[1]!, async (args) => {
    const saved = drafts.save({
      name: String(args.name),
      game: String(args.game),
      description: String(args.description),
      installGuide: String(args.installGuide),
      containerSupport: args.containerSupport as "full" | "partial" | "none" | undefined,
      warnings: args.warnings ? String(args.warnings) : undefined,
    });
    return saved;
  });

  orch.registerTool(toolDefs[2]!, async () => drafts.list());

  orch.registerTool(toolDefs[3]!, async (args) => {
    return drafts.promote(String(args.slug));
  });

  orch.registerTool(toolDefs[4]!, async (args) => {
    const server = await servers.createFromSkill({
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
      join,
    };
  });

  orch.registerTool(toolDefs[5]!, async (args) => {
    const server = await servers.start(String(args.serverId));
    await publishServerPanel(servers, panel, server.id, "running");
    const detail = await servers.detail(server.id);
    return {
      serverId: server.id,
      status: server.status,
      runtime: detail?.runtime,
      join: detail?.runtime.join,
    };
  });

  orch.registerTool(toolDefs[6]!, async (args) => {
    const server = await servers.stop(String(args.serverId));
    await publishServerPanel(servers, panel, server.id, "stopped");
    return { serverId: server.id, status: server.status };
  });

  orch.registerTool(toolDefs[7]!, async (args) => {
    const server = await servers.restart(String(args.serverId));
    await publishServerPanel(servers, panel, server.id, "running");
    const detail = await servers.detail(server.id);
    return {
      serverId: server.id,
      status: server.status,
      runtime: detail?.runtime,
      join: detail?.runtime.join,
    };
  });


  orch.registerTool(toolDefs[8]!, async () => {
    const rows = await servers.list();
    return rows.map((s) => ({
      id: s.id,
      name: s.name,
      game: s.game,
      status: s.status,
    }));
  });

  orch.registerTool(toolDefs[9]!, async (args) => {
    const blocks = Array.isArray(args.blocks) ? args.blocks : [];
    const parsedBlocks = blocks.map((block, index) => {
      const raw = block as Record<string, unknown>;
      return {
        type: PanelBlockTypeSchema.parse(normalizePanelBlockType(raw.type)),
        title: String(raw.title),
        body: (raw.body as Record<string, unknown> | undefined) ?? {},
        sortOrder: typeof raw.sortOrder === "number" ? raw.sortOrder : index,
      };
    });
    const published = await panel.publish({
      serverId: args.serverId ? String(args.serverId) : undefined,
      blocks: parsedBlocks,
    });
    return { published: published.length, blocks: published };
  });

  orch.registerTool(toolDefs[10]!, async (args) => {
    const rows = await panel.list(args.serverId ? String(args.serverId) : undefined);
    return rows;
  });

  orch.registerTool(toolDefs[11]!, async (args) => {
    const serverId = String(args.serverId);
    const label = args.label ? String(args.label) : `snapshot-${Date.now()}`;
    const snapshot = await snapshots.create(serverId, label);
    return { snapshotId: snapshot.id, label: snapshot.label, path: snapshot.path };
  });

  orch.registerTool(toolDefs[12]!, async (args) => {
    const snapshotId = String(args.snapshotId);
    const snapshot = await snapshots.get(snapshotId);
    if (!snapshot) throw new Error(`unknown_snapshot: ${snapshotId}`);

    const server = await withSnapshot(snapshots, snapshot.serverId, "pre-restore", async () =>
      snapshots.restore(snapshotId),
    );
    return { serverId: server.id, status: server.status, restoredFrom: snapshotId };
  });

  orch.registerTool(toolDefs[13]!, async (args) => {
    const rows = await snapshots.list(args.serverId ? String(args.serverId) : undefined);
    return rows.map((s) => ({
      id: s.id,
      serverId: s.serverId,
      label: s.label,
      createdAt: s.createdAt.toISOString(),
    }));
  });

  orch.registerTool(toolDefs[14]!, async (args) =>
    snapshots.enforceRetention(args.serverId ? String(args.serverId) : undefined, {
      maxCount:
        args.maxCount !== undefined ? Number(args.maxCount) : 10,
      maxAgeHours:
        args.maxAgeHours !== undefined ? Number(args.maxAgeHours) : 72,
    }),
  );

  orch.registerTool(toolDefs[15]!, async (args) =>
    serverFs.list(String(args.serverId), args.path ? String(args.path) : "."),
  );

  orch.registerTool(toolDefs[16]!, async (args) =>
    serverFs.read(String(args.serverId), String(args.path)),
  );

  orch.registerTool(toolDefs[17]!, async (args) =>
    serverFs.write(String(args.serverId), String(args.path), String(args.content)),
  );

  orch.registerTool(toolDefs[18]!, async (args) =>
    net.portCheck({
      host: args.host ? String(args.host) : undefined,
      port: Number(args.port),
    }),
  );

  orch.registerTool(toolDefs[19]!, async (args) =>
    net.suggestBind({
      preferredPort: args.preferredPort !== undefined ? Number(args.preferredPort) : undefined,
      host: args.host ? String(args.host) : undefined,
    }),
  );

  orch.registerTool(toolDefs[20]!, async (args) =>
    net.fetchUrl({
      serverId: String(args.serverId),
      url: String(args.url),
      destPath: String(args.destPath),
    }),
  );

  orch.registerTool(toolDefs[21]!, async (args) =>
    health.checkServer(String(args.serverId), {
      remediate: Boolean(args.remediate),
    }),
  );

  orch.registerTool(toolDefs[22]!, async (args) => {
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

  orch.registerTool(toolDefs[23]!, async (args) => {
    const zipPath = path.resolve(String(args.zipPath));
    const root = path.resolve(config.dataRoot);
    if (zipPath !== root && !zipPath.startsWith(root + path.sep)) {
      throw new Error("zip_path_outside_data_root");
    }
    const bytes = new Uint8Array(fs.readFileSync(zipPath));
    return skillPackages.importZip(bytes, { overwrite: Boolean(args.overwrite) });
  });

  orch.registerTool(toolDefs[24]!, async (args) =>
    skillPackages.promoteServerSkill(String(args.serverId), String(args.skillSlug), {
      overwrite: Boolean(args.overwrite),
    }),
  );

  orch.registerTool(toolDefs[25]!, async (args) => placement.plan(String(args.skillName)));

  orch.registerTool(toolDefs[26]!, async (args) =>
    migrate.relocate(String(args.serverId), String(args.targetNodeId)),
  );

  orch.registerTool(toolDefs[27]!, async (args) =>
    offNode.backupServer(String(args.serverId), args.label ? String(args.label) : undefined),
  );

  orch.registerTool(toolDefs[28]!, async (args) =>
    offNode.list(args.serverId ? String(args.serverId) : undefined),
  );

  orch.registerTool(toolDefs[29]!, async (args) =>
    offNode.restore(String(args.backupId), args.serverId ? String(args.serverId) : undefined),
  );

  orch.registerTool(toolDefs[30]!, async (args) =>
    importLocal.importFromPath({
      sourcePath: String(args.sourcePath),
      serverName: args.serverName ? String(args.serverName) : undefined,
      skillName: args.skillName ? String(args.skillName) : undefined,
      game: args.game ? String(args.game) : undefined,
      nodeId: args.nodeId ? String(args.nodeId) : undefined,
    }),
  );

  orch.registerTool(toolDefs[31]!, async (args) => {
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

  return orch;
}



// Re-export for callers that need direct snapshot access in tests or future routes.
export { SnapshotService, withSnapshot };
