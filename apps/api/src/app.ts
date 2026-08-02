import { createHash } from "node:crypto";
import type { Server as NodeHttpServer } from "node:http";
import { createNodeWebSocket } from "@hono/node-ws";
import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { cors } from "hono/cors";
import { and, asc, count, desc, eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { z } from "zod";
import type { ConfirmGate, LlmMessage } from "@playon/agent-core";
import { pickPersona } from "@playon/agent-core";
import {
  BootstrapOwnerSchema,
  LoginSchema,
  NodeHeartbeatSchema,
  RoleSchema,
  can,
  deriveNodePresence,
  roleAtLeast,
  type Role,
  type WsEvent,
} from "@playon/shared";
import {
  buildCorsOrigins,
  findRepoRoot,
  resolveWebDist,
  type AppConfig,
} from "./config.js";
import type { Db } from "./db/client.js";
import { conversations, messages, nodes, toolInvocations, users } from "./db/schema.js";
import { redactJson, redactString } from "./services/redaction.js";
import { mountStaticWeb } from "./static-web.js";

import { nodeTokenAuthorized } from "./auth/node-token.js";
import { hashPassword, verifyPassword } from "./auth/password.js";
import {
  SESSION_COOKIE,
  createSession,
  destroySession,
  getUserBySession,
  type AuthUser,
} from "./auth/session.js";
import { encryptSecret } from "./services/secrets.js";
import {
  getSetting,
  LLM_SETTINGS_KEY,
  setSetting,
  toPublicLlmSettings,
  type LlmSettings,
} from "./services/settings.js";
import { listSkills, skillsRootsForWorkspace } from "./services/skills.js";
import { SkillPackageService } from "./services/skill-packages.js";
import { ConfirmService } from "./services/confirm.js";
import { EventHub } from "./services/event-hub.js";
import { HealthService } from "./services/health.js";
import { NetToolsService } from "./services/net-tools.js";
import { PanelService } from "./services/panel.js";
import { resolvePanelTheme } from "./services/panel-theme.js";
import { publishServerPanel } from "./services/server-panel.js";
import { ServerService } from "./services/servers.js";
import { MigrateService } from "./services/migrate.js";
import { labelForTool, verbForTool } from "./services/agent-activity.js";
import { AgentProgressService } from "./services/agent-progress.js";
import { ImportLocalService } from "./services/import-local.js";
import { ImportSftpService } from "./services/import-sftp.js";
import { OffNodeBackupService } from "./services/offnode-backup.js";
import { PlacementService } from "./services/placement.js";
import { SnapshotService } from "./services/snapshots.js";
import { nodeJobService } from "./services/node-jobs.js";
import { createLlmClient, createOrchestrator } from "./services/tools.js";


type Vars = {
  user: AuthUser | null;
  db: Db;
  config: AppConfig;
};

const CREATE_BIND_TOOLS = new Set([
  "servers_create_from_skill",
  "servers_import_local",
  "servers_import_sftp",
]);

/** Prefer create/import tool results when binding an unbound install conversation. */
function serverIdFromCreateTrace(
  toolTrace: Array<{ name: string; result?: unknown }>,
): string | undefined {
  for (const trace of toolTrace) {
    if (!CREATE_BIND_TOOLS.has(trace.name)) continue;
    const result = trace.result;
    if (!result || typeof result !== "object") continue;
    const rec = result as Record<string, unknown>;
    if (typeof rec.error === "string") continue;
    if (typeof rec.serverId === "string" && rec.serverId) return rec.serverId;
    const nested = rec.server;
    if (nested && typeof nested === "object") {
      const id = (nested as { id?: unknown }).id;
      if (typeof id === "string" && id) return id;
    }
  }
  return undefined;
}

export type PlayOnApp = Hono<{ Variables: Vars }> & {
  injectWebSocket: (server: NodeHttpServer) => void;
  eventHub: EventHub;
  confirmService: ConfirmService;
};

const LlmSettingsPutSchema = z.object({
  provider: z.enum(["openai_compatible", "ollama"]),
  baseUrl: z.string().optional(),
  model: z.string().optional(),
  apiKey: z.string().optional(),
});

const CreateServerSchema = z
  .object({
    skillName: z.string().min(1).optional(),
    skillId: z.string().min(1).optional(),
    serverName: z.string().optional(),
    name: z.string().optional(),
    nodeId: z.string().optional(),
  })
  .transform((body) => ({
    skillName: body.skillName ?? body.skillId,
    serverName: body.serverName ?? body.name,
    nodeId: body.nodeId,
  }))
  .refine((body) => !!body.skillName, { message: "skillName_required" });


const PanelInputSchema = z.object({
  blockId: z.string().optional(),
  type: z.enum(["readiness", "vote"]),
  payload: z.record(z.unknown()).default({}),
});

const CreateUserSchema = z.object({
  username: z.string().min(3),
  password: z.string().min(8),
  displayName: z.string().min(1).optional(),
  role: z.enum(["admin", "operator"]),
});

export function createApp(db: Db, config: AppConfig): PlayOnApp {
  const app = new Hono<{ Variables: Vars }>();
  const eventHub = new EventHub();
  const confirmService = new ConfirmService(eventHub);
  const serverService = new ServerService(db, config, eventHub);
  const snapshotService = new SnapshotService(db, config, serverService);
  const panelService = new PanelService(db, eventHub);
  const netTools = new NetToolsService(serverService);
  const healthService = new HealthService(serverService, netTools, config);
  const placementService = new PlacementService(db, config, netTools);
  const migrateService = new MigrateService(
    db,
    serverService,
    snapshotService,
    placementService,
    eventHub,
  );
  const offNodeBackup = new OffNodeBackupService(db, config, snapshotService);
  const importLocal = new ImportLocalService(db, config, serverService, snapshotService);
  const importSftp = new ImportSftpService(db, config, serverService, snapshotService);
  const agentProgress = new AgentProgressService(db);
  const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });

  const corsOrigins =
    config.corsOrigins ??
    buildCorsOrigins({
      advertiseHost: config.advertiseHost,
      port: config.port,
    });
  app.use(
    "*",
    cors({
      origin: corsOrigins,
      credentials: true,
    }),
  );

  app.use("*", async (c, next) => {
    c.set("db", db);
    c.set("config", config);
    const sessionId = getCookie(c, SESSION_COOKIE);
    c.set("user", await getUserBySession(db, sessionId));
    await next();
  });

  app.get(
    "/api/ws",
    upgradeWebSocket((c) => {
      const user = c.get("user");
      let unsubscribe: (() => void) | undefined;
      return {
        onOpen(_event, ws) {
          if (!user || !roleAtLeast(user.role, "operator")) {
            ws.close(1008, "forbidden");
            return;
          }
          unsubscribe = eventHub.subscribe((event: WsEvent) => {
            try {
              ws.send(JSON.stringify(event));
            } catch {
              // closed mid-send
            }
          });
        },
        onMessage(event, ws) {
          // clients may send ping JSON; ignore invalid
          if (typeof event.data !== "string") return;
          try {
            const parsed = JSON.parse(event.data) as { type?: string };
            if (parsed.type === "ping") {
              ws.send(JSON.stringify({ type: "pong" }));
            }
          } catch {
            // ignore
          }
        },
        onClose() {
          unsubscribe?.();
        },
        onError() {
          unsubscribe?.();
        },
      };
    }),
  );

  /** Public player WebSocket — panel.updated only (LAN phones must not thrash admin /api/ws). */
  app.get(
    "/api/panel/ws",
    upgradeWebSocket(() => {
      let unsubscribe: (() => void) | undefined;
      return {
        onOpen(_event, ws) {
          unsubscribe = eventHub.subscribe((event: WsEvent) => {
            if (event.type !== "panel.updated") return;
            try {
              ws.send(JSON.stringify(event));
            } catch {
              // closed mid-send
            }
          });
        },
        onMessage(event, ws) {
          if (typeof event.data !== "string") return;
          try {
            const parsed = JSON.parse(event.data) as { type?: string };
            if (parsed.type === "ping") {
              ws.send(JSON.stringify({ type: "pong" }));
            }
          } catch {
            // ignore
          }
        },
        onClose() {
          unsubscribe?.();
        },
        onError() {
          unsubscribe?.();
        },
      };
    }),
  );

  const panelInputHits = new Map<string, { n: number; reset: number }>();
  const allowPanelInput = (key: string): boolean => {
    const now = Date.now();
    const cur = panelInputHits.get(key);
    if (!cur || now > cur.reset) {
      panelInputHits.set(key, { n: 1, reset: now + 60_000 });
      return true;
    }
    if (cur.n >= 40) return false;
    cur.n += 1;
    return true;
  };

  app.get("/api/health", (c) =>
    c.json({
      ok: true,
      product: "PlayOn",
      llmMode: config.llmMode,
      runtimeMode: config.runtimeMode,
    }),
  );

  app.get("/api/setup", async (c) => {
    const [{ value }] = await db.select({ value: count() }).from(users);
    return c.json({ needsSetup: value === 0, product: "PlayOn" as const });
  });

  app.post("/api/setup/owner", async (c) => {
    const [{ value }] = await db.select({ value: count() }).from(users);
    if (value > 0) return c.json({ error: "already_setup" }, 409);

    const body = BootstrapOwnerSchema.parse(await c.req.json());
    const id = nanoid();
    const now = new Date();
    await db.insert(users).values({
      id,
      username: body.username,
      displayName: body.displayName ?? body.username,
      passwordHash: hashPassword(body.password),
      role: "owner",
      createdAt: now,
    });

    const sessionId = await createSession(db, id);
    setCookie(c, SESSION_COOKIE, sessionId, {
      httpOnly: true,
      sameSite: "Lax",
      path: "/",
    });

    return c.json({
      user: {
        id,
        username: body.username,
        displayName: body.displayName ?? body.username,
        role: "owner" as Role,
      },
    });
  });

  app.post("/api/auth/login", async (c) => {
    const body = LoginSchema.parse(await c.req.json());
    const rows = await db.select().from(users).where(eq(users.username, body.username)).limit(1);
    const user = rows[0];
    if (!user || !verifyPassword(body.password, user.passwordHash)) {
      return c.json({ error: "invalid_credentials" }, 401);
    }
    const sessionId = await createSession(db, user.id);
    setCookie(c, SESSION_COOKIE, sessionId, {
      httpOnly: true,
      sameSite: "Lax",
      path: "/",
    });
    return c.json({
      user: {
        id: user.id,
        username: user.username,
        displayName: user.displayName,
        role: user.role as Role,
      },
    });
  });

  app.post("/api/auth/logout", async (c) => {
    await destroySession(db, getCookie(c, SESSION_COOKIE));
    deleteCookie(c, SESSION_COOKIE, { path: "/" });
    return c.json({ ok: true });
  });

  app.get("/api/auth/me", async (c) => {
    const user = c.get("user");
    if (!user) return c.json({ error: "unauthorized" }, 401);
    return c.json({ user });
  });

  app.get("/api/settings/llm", async (c) => {
    const user = c.get("user");
    if (!user || !can(user.role, "settings.llm")) {
      return c.json({ error: "forbidden" }, 403);
    }
    const stored = await getSetting<LlmSettings>(db, LLM_SETTINGS_KEY);
    const settings = stored ?? { provider: config.llmMode };
    return c.json({ llm: toPublicLlmSettings(settings) });
  });

  app.put("/api/settings/llm", async (c) => {
    const user = c.get("user");
    if (!user || !can(user.role, "settings.llm")) {
      return c.json({ error: "forbidden" }, 403);
    }
    const body = LlmSettingsPutSchema.parse(await c.req.json());
    const existing = (await getSetting<LlmSettings>(db, LLM_SETTINGS_KEY)) ?? {
      provider: body.provider,
    };

    const next: LlmSettings = {
      provider: body.provider,
      baseUrl: body.baseUrl ?? existing.baseUrl,
      model: body.model ?? existing.model,
      apiKeyEncrypted: existing.apiKeyEncrypted,
    };

    if (body.apiKey !== undefined) {
      next.apiKeyEncrypted = body.apiKey
        ? encryptSecret(config.sessionSecret, body.apiKey)
        : undefined;
    }

    await setSetting(db, LLM_SETTINGS_KEY, next);
    return c.json({ llm: toPublicLlmSettings(next) });
  });

  const skillPackages = new SkillPackageService(config);

  app.get("/api/skills", async (c) => {
    const user = c.get("user");
    if (!user || !roleAtLeast(user.role, "operator")) {
      return c.json({ error: "forbidden" }, 403);
    }
    const serverId = c.req.query("serverId") || undefined;
    if (serverId) {
      const server = await serverService.get(serverId);
      if (!server) return c.json({ error: "server_not_found" }, 404);
    }
    const roots = skillsRootsForWorkspace(config.skillsRoots, config.dataRoot, serverId);
    const skills = listSkills(roots).map((s) => {
      const normalized = s.path.replace(/\\/g, "/");
      const isServerSkill = Boolean(
        serverId && normalized.includes(`/servers/${serverId}/skills`),
      );
      return {
        id: s.id,
        name: s.metadata.name,
        version: s.metadata.version,
        game: s.metadata.game,
        description: s.metadata.description,
        tags: s.metadata.tags,
        theme: s.metadata.theme ?? null,
        scope: isServerSkill ? ("server" as const) : ("global" as const),
      };
    });
    return c.json({ skills });
  });

  app.get("/api/skills/:name/export", async (c) => {
    const user = c.get("user");
    if (!user || !can(user.role, "skills.package")) {
      return c.json({ error: "forbidden" }, 403);
    }
    try {
      const exported = skillPackages.exportZip(decodeURIComponent(c.req.param("name")));
      return new Response(Buffer.from(exported.bytes), {
        headers: {
          "content-type": "application/zip",
          "content-disposition": `attachment; filename="${exported.filename}"`,
        },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "export_failed";
      const status = message.startsWith("unknown_skill") ? 404 : 400;
      return c.json({ error: message }, status);
    }
  });

  app.post("/api/skills/import", async (c) => {
    const user = c.get("user");
    if (!user || !can(user.role, "skills.package")) {
      return c.json({ error: "forbidden" }, 403);
    }
    try {
      const contentType = c.req.header("content-type") ?? "";
      let bytes: Uint8Array;
      let overwrite = false;
      if (contentType.includes("multipart/form-data")) {
        const body = await c.req.parseBody();
        const file = body.file;
        if (!(file instanceof File)) return c.json({ error: "file_required" }, 400);
        bytes = new Uint8Array(await file.arrayBuffer());
        overwrite = body.overwrite === "true" || body.overwrite === "1";
      } else {
        const body = z
          .object({
            zipBase64: z.string().min(1),
            overwrite: z.boolean().optional(),
          })
          .parse(await c.req.json());
        bytes = Uint8Array.from(Buffer.from(body.zipBase64, "base64"));
        overwrite = body.overwrite ?? false;
      }
      const imported = skillPackages.importZip(bytes, { overwrite });
      return c.json({ skill: imported });
    } catch (err) {
      const message = err instanceof Error ? err.message : "import_failed";
      const status = message.startsWith("skill_exists") ? 409 : 400;
      return c.json({ error: message }, status);
    }
  });

  app.post("/api/skills/promote-server", async (c) => {
    const user = c.get("user");
    if (!user || !can(user.role, "skills.package")) {
      return c.json({ error: "forbidden" }, 403);
    }
    try {
      const body = z
        .object({
          serverId: z.string().min(1),
          skillSlug: z.string().min(1),
          overwrite: z.boolean().optional(),
        })
        .parse(await c.req.json());
      const promoted = skillPackages.promoteServerSkill(body.serverId, body.skillSlug, {
        overwrite: body.overwrite,
      });
      return c.json({ skill: promoted });
    } catch (err) {
      const message = err instanceof Error ? err.message : "promote_failed";
      const status = message.startsWith("unknown_server_skill")
        ? 404
        : message.startsWith("skill_exists")
          ? 409
          : 400;
      return c.json({ error: message }, status);
    }
  });

  app.get("/api/servers", async (c) => {
    const user = c.get("user");
    if (!user || !roleAtLeast(user.role, "operator")) {
      return c.json({ error: "forbidden" }, 403);
    }
    const list = await serverService.list();
    return c.json({
      servers: list,
      advertiseHost: config.advertiseHost,
      runtimeMode: config.runtimeMode,
    });
  });

  app.get("/api/servers/:id", async (c) => {
    const user = c.get("user");
    if (!user || !roleAtLeast(user.role, "operator")) {
      return c.json({ error: "forbidden" }, 403);
    }
    const detail = await serverService.detail(c.req.param("id"));
    if (!detail) return c.json({ error: "not_found" }, 404);
    return c.json(detail);
  });

  app.get("/api/servers/:id/health", async (c) => {
    const user = c.get("user");
    if (!user || !roleAtLeast(user.role, "operator")) {
      return c.json({ error: "forbidden" }, 403);
    }
    const remediate = c.req.query("remediate") === "1" || c.req.query("remediate") === "true";
    try {
      const report = await healthService.checkServer(c.req.param("id"), { remediate });
      return c.json(report);
    } catch (err) {
      const message = err instanceof Error ? err.message : "health_failed";
      return c.json({ error: message }, 400);
    }
  });

  app.get("/api/servers/:id/conversations", async (c) => {
    const user = c.get("user");
    if (!user || !can(user.role, "chat.agent")) {
      return c.json({ error: "forbidden" }, 403);
    }
    const serverId = c.req.param("id");
    const server = await serverService.get(serverId);
    if (!server) return c.json({ error: "not_found" }, 404);

    const rows = await db
      .select({
        id: conversations.id,
        serverId: conversations.serverId,
        title: conversations.title,
        createdAt: conversations.createdAt,
        updatedAt: conversations.updatedAt,
      })
      .from(conversations)
      .where(and(eq(conversations.userId, user.id), eq(conversations.serverId, serverId)))
      .orderBy(desc(conversations.updatedAt));

    return c.json({
      conversations: rows.map((row) => ({
        id: row.id,
        serverId: row.serverId,
        title: row.title,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
      })),
    });
  });

  app.post("/api/servers/:id/conversations", async (c) => {
    const user = c.get("user");
    if (!user || !can(user.role, "chat.agent")) {
      return c.json({ error: "forbidden" }, 403);
    }
    const serverId = c.req.param("id");
    const server = await serverService.get(serverId);
    if (!server) return c.json({ error: "not_found" }, 404);

    const body = z
      .object({ title: z.string().min(1).max(120).optional() })
      .parse((await c.req.json().catch(() => ({}))) as unknown);
    const now = new Date();
    const id = nanoid();
    await db.insert(conversations).values({
      id,
      userId: user.id,
      serverId,
      title: body.title ?? "New session",
      createdAt: now,
      updatedAt: now,
    });

    return c.json({
      conversation: {
        id,
        serverId,
        title: body.title ?? "New session",
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
      },
    });
  });

  app.post("/api/servers", async (c) => {
    const user = c.get("user");
    if (!user || !roleAtLeast(user.role, "operator")) {
      return c.json({ error: "forbidden" }, 403);
    }
    const body = CreateServerSchema.parse(await c.req.json());
    try {
      const server = await serverService.createFromSkill({
        skillName: body.skillName!,
        serverName: body.serverName,
        nodeId: body.nodeId,
      });
      await publishServerPanel(serverService, panelService, server.id, "stopped");
      return c.json({ server });
    } catch (err) {
      const message = err instanceof Error ? err.message : "create_failed";
      return c.json({ error: message }, 400);
    }
  });

  app.post("/api/servers/import", async (c) => {
    const user = c.get("user");
    if (!user || !can(user.role, "servers.manage")) {
      return c.json({ error: "forbidden" }, 403);
    }
    try {
      const body = z
        .object({
          sourcePath: z.string().min(1),
          serverName: z.string().min(1).optional(),
          skillName: z.string().min(1).optional(),
          game: z.string().min(1).optional(),
          nodeId: z.string().min(1).optional(),
        })
        .parse(await c.req.json());
      const report = await importLocal.importFromPath(body);
      await publishServerPanel(serverService, panelService, report.server.id, "stopped");
      return c.json({
        import: {
          server: report.server,
          skillName: report.skillName,
          skillSource: report.skillSource,
          draftSlug: report.draftSlug,
          baselineSnapshotId: report.baselineSnapshotId,
          copiedBytes: report.copiedBytes,
          detectedHints: report.detectedHints,
          followUp: report.followUp,
        },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "import_failed";
      return c.json({ error: message }, 400);
    }
  });

  app.post("/api/servers/import/sftp", async (c) => {
    const user = c.get("user");
    if (!user || !can(user.role, "servers.manage")) {
      return c.json({ error: "forbidden" }, 403);
    }
    try {
      const body = z
        .object({
          host: z.string().min(1),
          port: z.number().int().positive().optional(),
          username: z.string().min(1),
          password: z.string().min(1).optional(),
          privateKey: z.string().min(1).optional(),
          remotePath: z.string().min(1),
          serverName: z.string().min(1).optional(),
          skillName: z.string().min(1).optional(),
          game: z.string().min(1).optional(),
          nodeId: z.string().min(1).optional(),
        })
        .parse(await c.req.json());
      const report = await importSftp.importFromSftp(body);
      await publishServerPanel(serverService, panelService, report.server.id, "stopped");
      return c.json({
        import: {
          server: report.server,
          skillName: report.skillName,
          skillSource: report.skillSource,
          draftSlug: report.draftSlug,
          baselineSnapshotId: report.baselineSnapshotId,
          copiedBytes: report.copiedBytes,
          detectedHints: report.detectedHints,
          followUp: report.followUp,
          remoteHost: report.remoteHost,
          remotePath: report.remotePath,
        },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "sftp_import_failed";
      return c.json({ error: message }, 400);
    }
  });

  app.post("/api/servers/:id/start", async (c) => {
    const user = c.get("user");
    if (!user || !roleAtLeast(user.role, "operator")) {
      return c.json({ error: "forbidden" }, 403);
    }
    try {
      const server = await serverService.start(c.req.param("id"));
      await publishServerPanel(serverService, panelService, server.id, "running");
      const detail = await serverService.detail(server.id);
      return c.json({ server, runtime: detail?.runtime });
    } catch (err) {
      const message = err instanceof Error ? err.message : "start_failed";
      return c.json({ error: message }, 400);
    }
  });

  app.post("/api/servers/:id/stop", async (c) => {
    const user = c.get("user");
    if (!user || !roleAtLeast(user.role, "operator")) {
      return c.json({ error: "forbidden" }, 403);
    }
    try {
      const server = await serverService.stop(c.req.param("id"));
      await publishServerPanel(serverService, panelService, server.id, "stopped");
      return c.json({ server });
    } catch (err) {
      const message = err instanceof Error ? err.message : "stop_failed";
      return c.json({ error: message }, 400);
    }
  });

  app.delete("/api/servers/:id", async (c) => {
    const user = c.get("user");
    if (!user || !can(user.role, "servers.manage")) {
      return c.json({ error: "forbidden" }, 403);
    }
    try {
      const removed = await serverService.remove(c.req.param("id"));
      await panelService.clearForServer(removed.id);
      return c.json({ ok: true, removed });
    } catch (err) {
      const message = err instanceof Error ? err.message : "delete_failed";
      const status = message.startsWith("unknown_server") ? 404 : 400;
      return c.json({ error: message }, status);
    }
  });

  app.post("/api/servers/:id/restart", async (c) => {
    const user = c.get("user");
    if (!user || !roleAtLeast(user.role, "operator")) {
      return c.json({ error: "forbidden" }, 403);
    }
    try {
      const server = await serverService.restart(c.req.param("id"));
      await publishServerPanel(serverService, panelService, server.id, "running");
      const detail = await serverService.detail(server.id);
      return c.json({ server, runtime: detail?.runtime });
    } catch (err) {
      const message = err instanceof Error ? err.message : "restart_failed";
      return c.json({ error: message }, 400);
    }
  });

  app.post("/api/servers/:id/relocate", async (c) => {
    const user = c.get("user");
    if (!user || !can(user.role, "servers.manage")) {
      return c.json({ error: "forbidden" }, 403);
    }
    try {
      const body = z
        .object({ targetNodeId: z.string().min(1) })
        .parse(await c.req.json());
      const result = await migrateService.relocate(c.req.param("id"), body.targetNodeId);
      await publishServerPanel(
        serverService,
        panelService,
        result.server.id,
        result.server.status === "running" ? "running" : "stopped",
      );
      return c.json({ relocate: result });
    } catch (err) {
      const message = err instanceof Error ? err.message : "relocate_failed";
      const status =
        message.startsWith("unknown_server") || message.startsWith("unknown_node")
          ? 404
          : 400;
      return c.json({ error: message }, status);
    }
  });


  app.get("/api/panel", async (c) => {
    const serverId = c.req.query("serverId");
    let blocks = await panelService.list(serverId);
    // Player panel is join-first: only show blocks for currently running servers
    // (unless a specific serverId filter was requested).
    if (!serverId) {
      const running = new Set(
        (await serverService.list())
          .filter((s) => s.status === "running")
          .map((s) => s.id),
      );
      blocks = blocks.filter((b) => !b.serverId || running.has(b.serverId));
    }
    const theme = resolvePanelTheme(config, blocks);
    const payload = {
      blocks: blocks.map((b) => ({
        id: b.id,
        serverId: b.serverId,
        type: b.type,
        title: b.title,
        body: b.body,
        sortOrder: b.sortOrder,
        updatedAt: b.updatedAt.toISOString(),
      })),
      theme,
    };
    const etag = `"${createHash("sha1").update(JSON.stringify(payload)).digest("hex")}"`;
    const inm = c.req.header("if-none-match");
    if (inm && inm === etag) {
      return new Response(null, {
        status: 304,
        headers: {
          ETag: etag,
          "Cache-Control": "private, max-age=2",
        },
      });
    }
    return c.json(payload, {
      status: 200,
      headers: {
        ETag: etag,
        "Cache-Control": "private, max-age=2",
      },
    });
  });

  app.post("/api/panel/input", async (c) => {
    const key =
      c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ||
      c.req.header("x-real-ip") ||
      "local";
    if (!allowPanelInput(key)) {
      return c.json({ error: "rate_limited" }, 429);
    }
    const body = PanelInputSchema.parse(await c.req.json());
    const result = await panelService.recordInput(body);
    return c.json(result);
  });

  app.get("/api/nodes", async (c) => {
    const user = c.get("user");
    if (!user || !roleAtLeast(user.role, "operator")) {
      return c.json({ error: "forbidden" }, 403);
    }
    const list = await db.select().from(nodes);
    const now = Date.now();
    return c.json({
      nodes: list.map((n) => ({
        id: n.id,
        name: n.name,
        os: n.os,
        docker: n.docker,
        freeDiskBytes: n.freeDiskBytes,
        agentVersion: n.agentVersion,
        lastSeenAt: n.lastSeenAt.toISOString(),
        status: deriveNodePresence(n.lastSeenAt, now),
      })),
    });
  });

  app.get("/api/placement", async (c) => {
    const user = c.get("user");
    if (!user || !can(user.role, "servers.manage")) {
      return c.json({ error: "forbidden" }, 403);
    }
    const skillName = c.req.query("skillName")?.trim();
    if (!skillName) return c.json({ error: "skillName_required" }, 400);
    try {
      const plan = await placementService.plan(skillName);
      return c.json({ placement: plan });
    } catch (err) {
      const message = err instanceof Error ? err.message : "placement_failed";
      const status = message.startsWith("unknown_skill") ? 404 : 400;
      return c.json({ error: message }, status);
    }
  });

  app.get("/api/snapshots", async (c) => {
    const user = c.get("user");
    if (!user || !can(user.role, "servers.manage")) {
      return c.json({ error: "forbidden" }, 403);
    }
    const serverId = c.req.query("serverId") || undefined;
    const list = await snapshotService.list(serverId);
    return c.json({
      snapshots: list.map((s) => ({
        id: s.id,
        serverId: s.serverId,
        label: s.label,
        createdAt: s.createdAt.toISOString(),
      })),
    });
  });

  app.post("/api/snapshots", async (c) => {
    const user = c.get("user");
    if (!user || !can(user.role, "servers.manage")) {
      return c.json({ error: "forbidden" }, 403);
    }
    try {
      const body = z
        .object({
          serverId: z.string().min(1),
          label: z.string().min(1).optional(),
        })
        .parse(await c.req.json());
      const snap = await snapshotService.create(body.serverId, body.label ?? "manual");
      return c.json({
        snapshot: {
          id: snap.id,
          serverId: snap.serverId,
          label: snap.label,
          createdAt: snap.createdAt.toISOString(),
        },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "snapshot_failed";
      const status = message.startsWith("unknown_server") ? 404 : 400;
      return c.json({ error: message }, status);
    }
  });

  app.post("/api/snapshots/:id/restore", async (c) => {
    const user = c.get("user");
    if (!user || !can(user.role, "snapshots.restore")) {
      return c.json({ error: "forbidden" }, 403);
    }
    try {
      const server = await snapshotService.restore(c.req.param("id"));
      return c.json({ server });
    } catch (err) {
      const message = err instanceof Error ? err.message : "restore_failed";
      const status = message.startsWith("unknown_snapshot") ? 404 : 400;
      return c.json({ error: message }, status);
    }
  });

  app.get("/api/backups/target", async (c) => {
    const user = c.get("user");
    if (!user || !can(user.role, "servers.manage")) {
      return c.json({ error: "forbidden" }, 403);
    }
    const rootPath = await offNodeBackup.getTarget();
    return c.json({ target: rootPath ? { rootPath } : null });
  });

  app.put("/api/backups/target", async (c) => {
    const user = c.get("user");
    if (!user || !can(user.role, "settings.llm")) {
      return c.json({ error: "forbidden" }, 403);
    }
    try {
      const body = z.object({ rootPath: z.string().min(1) }).parse(await c.req.json());
      const target = await offNodeBackup.setTarget(body.rootPath);
      return c.json({ target });
    } catch (err) {
      const message = err instanceof Error ? err.message : "backup_target_failed";
      return c.json({ error: message }, 400);
    }
  });

  app.get("/api/backups/offnode", async (c) => {
    const user = c.get("user");
    if (!user || !can(user.role, "servers.manage")) {
      return c.json({ error: "forbidden" }, 403);
    }
    const serverId = c.req.query("serverId") || undefined;
    const list = await offNodeBackup.list(serverId);
    return c.json({
      backups: list.map((b) => ({
        id: b.id,
        serverId: b.serverId,
        label: b.label,
        sourceSnapshotId: b.sourceSnapshotId,
        exportedAt: b.exportedAt,
      })),
    });
  });

  app.post("/api/backups/offnode", async (c) => {
    const user = c.get("user");
    if (!user || !can(user.role, "servers.manage")) {
      return c.json({ error: "forbidden" }, 403);
    }
    try {
      const body = z
        .object({
          serverId: z.string().min(1).optional(),
          snapshotId: z.string().min(1).optional(),
          label: z.string().min(1).optional(),
        })
        .parse(await c.req.json());
      const record = body.snapshotId
        ? await offNodeBackup.exportSnapshot(body.snapshotId)
        : body.serverId
          ? await offNodeBackup.backupServer(body.serverId, body.label)
          : null;
      if (!record) return c.json({ error: "serverId_or_snapshotId_required" }, 400);
      return c.json({
        backup: {
          id: record.id,
          serverId: record.serverId,
          label: record.label,
          sourceSnapshotId: record.sourceSnapshotId,
          exportedAt: record.exportedAt,
        },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "offnode_backup_failed";
      const status = message.startsWith("unknown_") ? 404 : 400;
      return c.json({ error: message }, status);
    }
  });

  app.post("/api/backups/offnode/:id/restore", async (c) => {
    const user = c.get("user");
    if (!user || !can(user.role, "snapshots.restore")) {
      return c.json({ error: "forbidden" }, 403);
    }
    try {
      const body = z
        .object({ serverId: z.string().min(1).optional() })
        .parse((await c.req.json().catch(() => ({}))) as unknown);
      const result = await offNodeBackup.restore(c.req.param("id"), body.serverId);
      return c.json({ restore: result });
    } catch (err) {
      const message = err instanceof Error ? err.message : "offnode_restore_failed";
      const status = message.startsWith("unknown_") ? 404 : 400;
      return c.json({ error: message }, status);
    }
  });
  app.get("/api/agents", async (c) => {
    const user = c.get("user");
    if (!user || !can(user.role, "servers.manage")) {
      return c.json({ error: "forbidden" }, 403);
    }
    const list = await agentProgress.listCast();
    return c.json({
      agents: list.map((a) => ({
        persona: a.persona,
        xp: a.xp,
        level: a.level,
        title: a.title,
        updatedAt: a.updatedAt.toISOString(),
      })),
    });
  });

  app.get("/api/activity", async (c) => {
    const user = c.get("user");
    if (!user || !can(user.role, "servers.manage")) {
      return c.json({ error: "forbidden" }, 403);
    }
    const limitRaw = Number(c.req.query("limit") ?? "40");
    const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 100) : 40;
    const rows = await db
      .select({
        id: toolInvocations.id,
        conversationId: toolInvocations.conversationId,
        userId: toolInvocations.userId,
        toolName: toolInvocations.toolName,
        argsJson: toolInvocations.argsJson,
        resultJson: toolInvocations.resultJson,
        status: toolInvocations.status,
        createdAt: toolInvocations.createdAt,
      })
      .from(toolInvocations)
      .orderBy(desc(toolInvocations.createdAt))
      .limit(limit);

    return c.json({
      activity: rows.map((row) => {
        let args: unknown = {};
        let result: unknown = null;
        try {
          args = JSON.parse(row.argsJson);
        } catch {
          args = {};
        }
        if (row.resultJson) {
          try {
            result = JSON.parse(row.resultJson);
          } catch {
            result = null;
          }
        }
        return {
          id: row.id,
          conversationId: row.conversationId,
          userId: row.userId,
          toolName: row.toolName,
          args: JSON.parse(redactJson(args)) as unknown,
          result: result === null ? null : (JSON.parse(redactJson(result)) as unknown),
          status: row.status,
          createdAt: row.createdAt.toISOString(),
        };
      }),
    });
  });

  app.post("/api/nodes/heartbeat", async (c) => {
    if (!nodeTokenAuthorized(c, config.nodeToken)) {
      return c.json({ error: "unauthorized" }, 401);
    }

    const body = NodeHeartbeatSchema.parse(await c.req.json());
    const now = new Date();
    const existing = await db.select().from(nodes).where(eq(nodes.id, body.nodeId)).limit(1);
    if (existing[0]) {
      await db
        .update(nodes)
        .set({
          name: body.name,
          os: body.os,
          docker: body.docker,
          freeDiskBytes: body.freeDiskBytes ?? null,
          agentVersion: body.agentVersion,
          lastSeenAt: now,
        })
        .where(eq(nodes.id, body.nodeId));
    } else {
      await db.insert(nodes).values({
        id: body.nodeId,
        name: body.name,
        os: body.os,
        docker: body.docker,
        freeDiskBytes: body.freeDiskBytes ?? null,
        agentVersion: body.agentVersion,
        lastSeenAt: now,
      });
    }

    eventHub.publish({
      type: "node.heartbeat",
      nodeId: body.nodeId,
      capabilities: {
        os: body.os,
        docker: body.docker,
        freeDiskBytes: body.freeDiskBytes,
      },
    });
    if (body.freeDiskBytes != null) {
      eventHub.publish({
        type: "node.metrics",
        nodeId: body.nodeId,
        metrics: { freeDiskBytes: body.freeDiskBytes },
      });
    }

    return c.json({ ok: true, status: "online" as const });
  });

  app.post("/api/nodes/:nodeId/logs", async (c) => {
    if (!nodeTokenAuthorized(c, config.nodeToken)) {
      return c.json({ error: "unauthorized" }, 401);
    }
    const nodeId = c.req.param("nodeId");
    const body = z
      .object({
        serverId: z.string().min(1),
        lines: z.array(z.string()).min(1).max(200),
      })
      .parse(await c.req.json());

    for (const line of body.lines) {
      eventHub.publish({
        type: "server.log",
        serverId: body.serverId,
        line,
        nodeId,
      });
    }
    return c.json({ ok: true, accepted: body.lines.length });
  });

  app.post("/api/nodes/:nodeId/metrics", async (c) => {
    if (!nodeTokenAuthorized(c, config.nodeToken)) {
      return c.json({ error: "unauthorized" }, 401);
    }
    const nodeId = c.req.param("nodeId");
    const body = z
      .object({
        freeDiskBytes: z.number().nonnegative().optional(),
        cpuPercent: z.number().min(0).max(100).optional(),
        memUsedBytes: z.number().nonnegative().optional(),
        memTotalBytes: z.number().nonnegative().optional(),
      })
      .parse(await c.req.json());

    eventHub.publish({
      type: "node.metrics",
      nodeId,
      metrics: body,
    });
    return c.json({ ok: true });
  });

  app.get("/api/nodes/:nodeId/jobs/next", async (c) => {
    if (!nodeTokenAuthorized(c, config.nodeToken)) {
      return c.json({ error: "unauthorized" }, 401);
    }
    const nodeId = c.req.param("nodeId");
    const job = nodeJobService.claimNext(nodeId);
    if (!job) return c.body(null, 204);
    return c.json({
      id: job.id,
      nodeId: job.nodeId,
      kind: job.kind,
      args: job.args,
    });
  });

  app.post("/api/nodes/:nodeId/jobs/:jobId/result", async (c) => {
    if (!nodeTokenAuthorized(c, config.nodeToken)) {
      return c.json({ error: "unauthorized" }, 401);
    }
    const nodeId = c.req.param("nodeId");
    const jobId = c.req.param("jobId");
    const existing = nodeJobService.get(jobId);
    if (!existing || existing.nodeId !== nodeId) {
      return c.json({ error: "job_not_found" }, 404);
    }
    const body = z
      .union([
        z.object({ ok: z.literal(true), result: z.unknown() }),
        z.object({ ok: z.literal(false), error: z.string().min(1) }),
      ])
      .parse(await c.req.json());
    const updated =
      body.ok === true
        ? nodeJobService.complete(jobId, body.result)
        : nodeJobService.fail(jobId, body.error);
    return c.json({
      id: updated.id,
      status: updated.status,
      error: updated.error,
    });
  });

  app.post("/api/nodes/:nodeId/jobs", async (c) => {
    const user = c.get("user");
    if (!user || !can(user.role, "servers.manage")) {
      return c.json({ error: "forbidden" }, 403);
    }
    const nodeId = c.req.param("nodeId");
    const body = z
      .object({
        kind: z.enum(["ping", "fs_list"]),
        args: z.record(z.unknown()).optional(),
      })
      .parse(await c.req.json());
    const job = nodeJobService.enqueue(nodeId, body.kind, body.args ?? {});
    return c.json({ job }, 201);
  });

  app.get("/api/nodes/:nodeId/jobs/:jobId", async (c) => {
    const user = c.get("user");
    if (!user || !can(user.role, "servers.manage")) {
      return c.json({ error: "forbidden" }, 403);
    }
    const nodeId = c.req.param("nodeId");
    const jobId = c.req.param("jobId");
    const job = nodeJobService.get(jobId);
    if (!job || job.nodeId !== nodeId) return c.json({ error: "job_not_found" }, 404);
    return c.json({ job });
  });

  app.get("/api/conversations", async (c) => {
    const user = c.get("user");
    if (!user || !can(user.role, "chat.agent")) {
      return c.json({ error: "forbidden" }, 403);
    }

    const serverId = c.req.query("serverId") || undefined;
    const rows = await db
      .select({
        id: conversations.id,
        serverId: conversations.serverId,
        title: conversations.title,
        createdAt: conversations.createdAt,
        updatedAt: conversations.updatedAt,
      })
      .from(conversations)
      .where(
        serverId
          ? and(eq(conversations.userId, user.id), eq(conversations.serverId, serverId))
          : eq(conversations.userId, user.id),
      )
      .orderBy(desc(conversations.updatedAt));

    return c.json({
      conversations: rows.map((row) => ({
        id: row.id,
        serverId: row.serverId,
        title: row.title,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
      })),
    });
  });

  app.get("/api/conversations/:id/messages", async (c) => {
    const user = c.get("user");
    if (!user || !can(user.role, "chat.agent")) {
      return c.json({ error: "forbidden" }, 403);
    }

    const conversationId = c.req.param("id");
    const rows = await db
      .select()
      .from(conversations)
      .where(eq(conversations.id, conversationId))
      .limit(1);
    const conversation = rows[0];
    if (!conversation) return c.json({ error: "not_found" }, 404);

    if (conversation.userId !== user.id) {
      return c.json({ error: "forbidden" }, 403);
    }

    const messageRows = await db
      .select({
        id: messages.id,
        role: messages.role,
        content: messages.content,
        createdAt: messages.createdAt,
      })
      .from(messages)
      .where(eq(messages.conversationId, conversationId))
      .orderBy(asc(messages.createdAt));

    return c.json({
      conversation: {
        id: conversation.id,
        serverId: conversation.serverId,
        title: conversation.title,
      },
      messages: messageRows.map((row) => ({
        id: row.id,
        role: row.role,
        content: row.content,
        createdAt: row.createdAt.toISOString(),
      })),
    });
  });

  app.post("/api/chat", async (c) => {
    const user = c.get("user");
    if (!user || !can(user.role, "chat.agent")) {
      return c.json({ error: "forbidden" }, 403);
    }
    const body = (await c.req.json()) as {
      message?: string;
      conversationId?: string;
      serverId?: string;
    };
    if (!body.message?.trim()) return c.json({ error: "message_required" }, 400);

    let conversationId = body.conversationId;
    /** Bound maintain chat when set; unbound install chat when undefined. */
    let workspaceServerId: string | undefined = body.serverId;
    const now = new Date();

    if (conversationId) {
      const existing = await db
        .select()
        .from(conversations)
        .where(eq(conversations.id, conversationId))
        .limit(1);
      const conversation = existing[0];
      if (!conversation || conversation.userId !== user.id) {
        return c.json({ error: "conversation_not_found" }, 404);
      }
      if (body.serverId && conversation.serverId && body.serverId !== conversation.serverId) {
        return c.json({ error: "serverId_mismatch" }, 400);
      }
      workspaceServerId = conversation.serverId ?? body.serverId;
      await db
        .update(conversations)
        .set({ updatedAt: now })
        .where(eq(conversations.id, conversationId));
    } else {
      if (body.serverId) {
        const server = await serverService.get(body.serverId);
        if (!server) return c.json({ error: "server_not_found" }, 404);
        workspaceServerId = body.serverId;
      } else {
        workspaceServerId = undefined;
      }
      conversationId = nanoid();
      await db.insert(conversations).values({
        id: conversationId,
        userId: user.id,
        serverId: workspaceServerId,
        title: body.message.slice(0, 80),
        createdAt: now,
        updatedAt: now,
      });
    }

    const priorRows = await db
      .select()
      .from(messages)
      .where(eq(messages.conversationId, conversationId))
      .orderBy(asc(messages.createdAt));

    const priorMessages: LlmMessage[] = priorRows
      .filter((row) => row.role === "user" || row.role === "assistant")
      .map((row) => ({
        role: row.role as "user" | "assistant",
        content: row.content,
      }));
    const conversationContext = priorMessages.map((m) => m.content).join("\n");

    await db.insert(messages).values({
      id: nanoid(),
      conversationId,
      role: "user",
      content: body.message,
      createdAt: now,
    });

    const persona = pickPersona(body.message, conversationContext);
    /** Mutable: unbound create binds activity to the new server mid-turn. */
    let activityServerId = workspaceServerId;
    const publishActivity = (
      phase: "thinking" | "tool_start" | "tool_done" | "tool_fail" | "confirm_wait" | "idle",
      opts?: { toolName?: string; verb?: ReturnType<typeof verbForTool>; label?: string },
    ) => {
      if (!activityServerId) return;
      const verb = opts?.verb ?? "other";
      eventHub.publish({
        type: "agent.activity",
        serverId: activityServerId,
        conversationId,
        persona,
        phase,
        verb,
        toolName: opts?.toolName,
        label:
          opts?.label ??
          (phase === "thinking"
            ? "Thinking…"
            : phase === "idle"
              ? "Idle"
              : phase === "confirm_wait"
                ? "Waiting for confirm…"
                : undefined),
      });
    };

    try {
      const llm = await createLlmClient(db, config);

      const confirmGate: ConfirmGate = {
        async requestConfirmation(request) {
          publishActivity("confirm_wait", {
            toolName: request.toolName,
            verb: verbForTool(request.toolName),
            label: "Waiting for confirm…",
          });
          try {
            return await confirmService.requestConfirmation(request);
          } finally {
            publishActivity("thinking", { label: "Thinking…", verb: "other" });
          }
        },
      };

      const orchestrator = createOrchestrator(db, config, llm, {
        confirmGate,
        eventHub,
        workspaceServerId,
        stream: {
          conversationId,
          onToken: (token) => {
            eventHub.publish({ type: "chat.token", conversationId, token });
          },
          onTool: ({ toolName, status, detail }) => {
            eventHub.publish({
              type: "chat.tool",
              conversationId,
              toolName,
              status,
              detail,
            });
            if (
              status === "completed" &&
              detail &&
              typeof detail.serverId === "string" &&
              detail.serverId &&
              !activityServerId
            ) {
              activityServerId = detail.serverId;
            }
            const verb = verbForTool(toolName);
            const phase =
              status === "started"
                ? "tool_start"
                : status === "failed"
                  ? "tool_fail"
                  : "tool_done";
            publishActivity(phase, {
              toolName,
              verb,
              label: labelForTool(toolName, verb),
            });
            // Don't leave the last tool label stuck while the LLM continues.
            if (status === "completed" || status === "failed") {
              publishActivity("thinking", { label: "Thinking…", verb: "other" });
            }
          },
        },
      });
      publishActivity("thinking");
      const result = await orchestrator.handle(persona, body.message, priorMessages);

      for (const trace of result.toolTrace) {
        const failed =
          trace.result &&
          typeof trace.result === "object" &&
          ("error" in (trace.result as object) ||
            (trace.result as { ok?: boolean }).ok === false);
        await db.insert(toolInvocations).values({
          id: nanoid(),
          conversationId,
          userId: user.id,
          toolName: trace.name,
          argsJson: redactJson(trace.arguments),
          resultJson: redactJson(trace.result),
          status: failed ? "error" : "ok",
          createdAt: new Date(),
        });
      }

      const createdServerId = serverIdFromCreateTrace(result.toolTrace);
      let boundServerId = workspaceServerId ?? createdServerId;
      if (!workspaceServerId && createdServerId) {
        await db
          .update(conversations)
          .set({ serverId: createdServerId, updatedAt: new Date() })
          .where(eq(conversations.id, conversationId));
        boundServerId = createdServerId;
        activityServerId = createdServerId;
      }

      const awards = boundServerId
        ? await agentProgress.awardForTools(result.persona, result.toolTrace)
        : [];
      const celebrations = awards.filter((a) => a.celebrate);
      for (const award of celebrations) {
        eventHub.publish({
          type: "agent.celebration",
          serverId: boundServerId!,
          persona: award.persona,
          reason: award.reason,
          xpGained: award.xpGained,
          level: award.progress.level,
          title: award.progress.title,
          leveledUp: award.leveledUp,
        });
      }

      const safeReply = redactString(result.content);
      await db.insert(messages).values({
        id: nanoid(),
        conversationId,
        role: "assistant",
        content: safeReply,
        createdAt: new Date(),
      });

      const stored = await getSetting<LlmSettings>(db, LLM_SETTINGS_KEY);
      const progress = boundServerId ? await agentProgress.get(result.persona) : undefined;

      return c.json({
        conversationId,
        serverId: boundServerId,
        reply: safeReply,
        persona: result.persona,
        llmMode: stored?.provider ?? config.llmMode,
        toolTrace: result.toolTrace,
        agentProgress: progress
          ? {
              persona: progress.persona,
              xp: progress.xp,
              level: progress.level,
              title: progress.title,
            }
          : undefined,
        celebrations: celebrations.map((a) => ({
          serverId: boundServerId,
          persona: a.persona,
          reason: a.reason,
          xpGained: a.xpGained,
          level: a.progress.level,
          title: a.progress.title,
          leveledUp: a.leveledUp,
        })),
      });
    } catch (err) {
      const messageText = err instanceof Error ? err.message : "chat_failed";
      console.error("chat failed:", messageText);
      const status = messageText.includes("llm_api_key_required") ? 400 : 502;
      return c.json({ error: messageText }, status);
    } finally {
      publishActivity("idle");
    }
  });

  app.post("/api/users", async (c) => {
    const user = c.get("user");
    if (!user || !can(user.role, "users.manage")) {
      return c.json({ error: "forbidden" }, 403);
    }
    const body = CreateUserSchema.parse(await c.req.json());
    const existing = await db
      .select()
      .from(users)
      .where(eq(users.username, body.username))
      .limit(1);
    if (existing[0]) return c.json({ error: "username_taken" }, 409);

    const id = nanoid();
    const now = new Date();
    await db.insert(users).values({
      id,
      username: body.username,
      displayName: body.displayName ?? body.username,
      passwordHash: await hashPassword(body.password),
      role: RoleSchema.parse(body.role),
      createdAt: now,
    });
    return c.json({
      user: {
        id,
        username: body.username,
        displayName: body.displayName ?? body.username,
        role: body.role as Role,
      },
    });
  });

  app.post("/api/confirm", async (c) => {
    const user = c.get("user");
    if (!user || !can(user.role, "confirm.host")) {
      return c.json({ error: "forbidden" }, 403);
    }
    const body = z
      .object({
        requestId: z.string().min(1),
        approved: z.boolean(),
      })
      .parse(await c.req.json());
    const ok = confirmService.resolve(body.requestId, body.approved);
    if (!ok) return c.json({ error: "unknown_or_expired_request" }, 404);
    return c.json({ ok: true, requestId: body.requestId, approved: body.approved });
  });

  const webDist =
    config.webDist ?? resolveWebDist(process.env, findRepoRoot(process.cwd()));
  mountStaticWeb(app, webDist);

  const playon = app as PlayOnApp;
  playon.injectWebSocket = injectWebSocket;
  playon.eventHub = eventHub;
  playon.confirmService = confirmService;
  return playon;
}
