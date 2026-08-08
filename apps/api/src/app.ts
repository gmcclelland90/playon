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
import { ChatAbortedError } from "@playon/agent-core";
import {
  BootstrapOwnerSchema,
  CreateWatcherSchema,
  HttpError,
  ImportLocalServerRequestSchema,
  ImportSftpServerRequestSchema,
  LLM_PRESET_IDS,
  LOCAL_NODE_ID,
  LoginSchema,
  NodeHeartbeatSchema,
  NodeJobKindSchema,
  RelocateServerRequestSchema,
  RoleSchema,
  UpdateWatcherSchema,
  can,
  deriveNodePresence,
  placementBadge,
  placementFromNodeKind,
  roleAtLeast,
  type NodeKind,
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
import { httpErrorHandler } from "./http-errors.js";
import {
  jsonBody,
  requireCan,
  requireRole,
  requireSession,
  serviceHttpError,
} from "./http-policy.js";
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
import { readAppVersion } from "./services/app-version.js";
import {
  CLOUD_SETTINGS_KEY,
  DEFAULT_NODE_SETTINGS,
  getSetting,
  LLM_SETTINGS_KEY,
  NODE_SETTINGS_KEY,
  SKILLS_CATALOG_KEY,
  setSetting,
  llmSettingsFromPut,
  toPublicCloudSettings,
  toPublicLlmSettings,
  toPublicNodeSettings,
  type LlmSettings,
  type NodeSettings,
  type SkillsCatalogSettings,
  type VultrCloudSettings,
} from "./services/settings.js";
import {
  buildVultrAuthorizeUrl,
  createVultrConnectSession,
  DEFAULT_VULTR_RELAY,
  exchangeVultrCode,
} from "./services/cloud/oauth-relay.js";
import {
  annotateCatalogInstalled,
  installSkillFromCatalog,
} from "./services/catalog-install.js";
import {
  fetchSkillsCatalogDetailed,
  resolveSkillsCatalogUrl,
  searchCatalog,
} from "./services/skills-catalog.js";
import { createControlPlane, type ControlPlane } from "./control-plane.js";
import {
  classifySkillSource,
  listSkills,
  loadSkillMetadata,
  skillsRootsForWorkspace,
} from "./services/skills.js";
import { SkillFsService, skillFsHttpStatus } from "./services/skill-fs.js";
import { readSkillMarker } from "./services/skill-marker.js";
import { ConfirmService } from "./services/confirm.js";
import { EventHub } from "./services/event-hub.js";
import { safeQueryLive } from "./services/server-panel.js";
import { execConsoleCommand } from "./services/server-console.js";
import { labelForTool, verbForTool } from "./services/agent-activity.js";
import { nodeJobService } from "./services/node-jobs.js";
import {
  authenticateAccessToken,
  bearerFromAuthorization,
  createAccessToken,
  listAccessTokens,
  revokeAccessToken,
} from "./services/access-tokens.js";
import { authInfoFromAccessToken, createPlayOnMcpHandler } from "./services/mcp.js";
import {
  createLlmClient,
  createOrchestrator,
  createPlayOnToolSurface,
} from "./services/tools.js";
import {
  DEFAULT_OLLAMA_OPENAI_BASE,
  getOllamaJob,
  probeOllama,
  startOllamaInstall,
  startOllamaPull,
} from "./services/ollama.js";


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
  controlPlane: ControlPlane;
};

const LlmSettingsPutSchema = z
  .object({
    preset: z.enum(LLM_PRESET_IDS).optional(),
    /** @deprecated Prefer preset; kept for older clients. */
    provider: z.enum(["openai_compatible", "ollama"]).optional(),
    baseUrl: z.string().optional(),
    model: z.string().optional(),
    apiKey: z.string().optional(),
  })
  .refine((body) => Boolean(body.preset || body.provider), {
    message: "preset_or_provider_required",
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
  serverId: z.string().optional(),
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
  const plane = createControlPlane(db, config);
  const {
    eventHub,
    confirm: confirmService,
    servers: serverService,
    snapshots: snapshotService,
    panel: panelService,
    playerPanel,
    queries: queryService,
    health: healthService,
    placement: placementService,
    migrate: migrateService,
    offNode: offNodeBackup,
    importLocal,
    manageSuggest,
    importSftp,
    agentProgress,
    skillPackages,
    drafts: draftService,
    serverFs,
    tunnel,
    addNode,
    installDocker,
    updates: updateService,
    watchers: watcherService,
    watcherEngine,
  } = plane;
  const skillFs = new SkillFsService(config);
  const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });

  // Keep player panel in sync with runtime reconcile/start/stop (not only explicit tool calls).
  eventHub.subscribe((event: WsEvent) => {
    if (event.type !== "server.status") return;
    void (async () => {
      try {
        if (event.status === "running" || event.status === "starting") {
          let live = null;
          if (event.status === "running") {
            live = await safeQueryLive(
              (id) => queryService.queryServerWithRetry(id, { attempts: 5, delayMs: 1200 }),
              event.serverId,
            );
          }
          await playerPanel.publishForStatus(event.serverId, event.status, live);
        } else if (event.status === "stopped" || event.status === "error") {
          await playerPanel.publishForStatus(event.serverId, event.status);
        }
      } catch {
        // panel sync must not break status fan-out
      }
    })();
  });

  const corsOrigins =
    config.corsOrigins ??
    buildCorsOrigins({
      advertiseHost: config.advertiseHost,
      port: config.port,
    });

  app.onError(httpErrorHandler);

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
      version: readAppVersion(),
      llmMode: config.llmMode,
      runtimeMode: config.runtimeMode,
    }),
  );

  app.get("/api/updates/status", async (c) => {
    const user = c.get("user");
    if (!user || !can(user.role, "settings.llm")) {
      return c.json({ error: "forbidden" }, 403);
    }
    const force = c.req.query("force") === "1" || c.req.query("force") === "true";
    try {
      return c.json(await updateService.getStatus({ force }));
    } catch (err) {
      const message = err instanceof Error ? err.message : "update_status_failed";
      return c.json({ error: message }, 400);
    }
  });

  app.post("/api/updates/home/apply", async (c) => {
    const user = c.get("user");
    if (!user || user.role !== "owner") {
      return c.json({ error: "forbidden" }, 403);
    }
    try {
      return c.json(await updateService.applyHomeUpdate());
    } catch (err) {
      const message = err instanceof Error ? err.message : "update_apply_failed";
      return c.json({ error: message }, 400);
    }
  });

  app.post("/api/nodes/:nodeId/update", async (c) => {
    const user = c.get("user");
    if (!user || user.role !== "owner") {
      return c.json({ error: "forbidden" }, 403);
    }
    const nodeId = c.req.param("nodeId");
    try {
      return c.json(await updateService.enqueueNodeUpdate(nodeId));
    } catch (err) {
      const message = err instanceof Error ? err.message : "node_update_failed";
      return c.json({ error: message }, 400);
    }
  });

  app.get("/api/setup", async (c) => {
    const [{ value }] = await db.select({ value: count() }).from(users);
    return c.json({ needsSetup: value === 0, product: "PlayOn" as const });
  });

  app.post("/api/setup/owner", async (c) => {
    const [{ value }] = await db.select({ value: count() }).from(users);
    if (value > 0) throw HttpError.conflict("already_setup", { code: "already_setup" });

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
      throw HttpError.unauthorized("invalid_credentials", { code: "invalid_credentials" });
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

  app.get("/api/auth/me", async (c) => c.json({ user: requireSession(c) }));

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
      provider: config.llmMode,
    };

    let resolved: ReturnType<typeof llmSettingsFromPut>;
    try {
      resolved = llmSettingsFromPut({
        preset: body.preset,
        provider: body.provider ?? existing.provider,
        baseUrl: body.baseUrl ?? existing.baseUrl,
        model: body.model ?? existing.model,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "llm_settings_invalid";
      return c.json({ error: message }, 400);
    }

    const next: LlmSettings = {
      ...resolved,
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

  app.get("/api/settings/llm/ollama/status", async (c) => {
    const user = c.get("user");
    if (!user || !can(user.role, "settings.llm")) {
      return c.json({ error: "forbidden" }, 403);
    }
    const stored = await getSetting<LlmSettings>(db, LLM_SETTINGS_KEY);
    const q = c.req.query("baseUrl")?.trim();
    const baseUrl = q || stored?.baseUrl?.trim() || DEFAULT_OLLAMA_OPENAI_BASE;
    const status = await probeOllama(baseUrl);
    return c.json({ ollama: status });
  });

  app.post("/api/settings/llm/ollama/install", async (c) => {
    const user = c.get("user");
    if (!user || !can(user.role, "settings.llm")) {
      return c.json({ error: "forbidden" }, 403);
    }
    const body = z
      .object({ baseUrl: z.string().optional() })
      .parse(await c.req.json().catch(() => ({})));
    const stored = await getSetting<LlmSettings>(db, LLM_SETTINGS_KEY);
    const baseUrl =
      body.baseUrl?.trim() || stored?.baseUrl?.trim() || DEFAULT_OLLAMA_OPENAI_BASE;
    const job = startOllamaInstall(baseUrl);
    if (job.phase === "error") {
      return c.json({ error: job.message ?? "ollama_install_failed", job }, 400);
    }
    return c.json({ job });
  });

  app.get("/api/settings/llm/ollama/job", async (c) => {
    const user = c.get("user");
    if (!user || !can(user.role, "settings.llm")) {
      return c.json({ error: "forbidden" }, 403);
    }
    return c.json({ job: getOllamaJob() });
  });

  app.post("/api/settings/llm/ollama/pull", async (c) => {
    const user = c.get("user");
    if (!user || !can(user.role, "settings.llm")) {
      return c.json({ error: "forbidden" }, 403);
    }
    const body = z
      .object({
        model: z.string().min(1),
        baseUrl: z.string().optional(),
      })
      .parse(await c.req.json());
    const stored = await getSetting<LlmSettings>(db, LLM_SETTINGS_KEY);
    const baseUrl =
      body.baseUrl?.trim() || stored?.baseUrl?.trim() || DEFAULT_OLLAMA_OPENAI_BASE;
    const job = startOllamaPull(baseUrl, body.model);
    if (job.phase === "error" && job.message === "ollama_model_required") {
      return c.json({ error: job.message, job }, 400);
    }
    if (job.phase === "error" && job.message === "ollama_job_busy") {
      return c.json({ error: job.message, job }, 409);
    }
    return c.json({ job });
  });

  app.get("/api/access-tokens", async (c) => {
    const user = c.get("user");
    if (!user || !can(user.role, "settings.llm")) {
      return c.json({ error: "forbidden" }, 403);
    }
    const tokens = await listAccessTokens(db, user.id);
    return c.json({
      tokens: tokens.map((t) => ({
        id: t.id,
        name: t.name,
        autoApproveConfirms: t.autoApproveConfirms,
        createdAt: t.createdAt.toISOString(),
        lastUsedAt: t.lastUsedAt?.toISOString() ?? null,
      })),
    });
  });

  app.post("/api/access-tokens", async (c) => {
    const user = c.get("user");
    if (!user || !can(user.role, "settings.llm")) {
      return c.json({ error: "forbidden" }, 403);
    }
    const body = z
      .object({
        name: z.string().min(1).max(80).default("MCP token"),
        autoApproveConfirms: z.boolean().optional(),
      })
      .parse(await c.req.json().catch(() => ({})));
    const created = await createAccessToken(db, {
      name: body.name,
      userId: user.id,
      autoApproveConfirms: body.autoApproveConfirms,
    });
    return c.json({
      token: {
        id: created.id,
        name: created.name,
        autoApproveConfirms: created.autoApproveConfirms,
        createdAt: created.createdAt.toISOString(),
        lastUsedAt: null,
        token: created.token,
      },
    });
  });

  app.delete("/api/access-tokens/:id", async (c) => {
    const user = c.get("user");
    if (!user || !can(user.role, "settings.llm")) {
      return c.json({ error: "forbidden" }, 403);
    }
    const id = c.req.param("id");
    const ok = await revokeAccessToken(db, id, user.id);
    if (!ok) return c.json({ error: "not_found" }, 404);
    return c.json({ ok: true });
  });

  app.get("/api/settings/cloud", async (c) => {
    const user = c.get("user");
    if (!user || !can(user.role, "settings.llm")) {
      return c.json({ error: "forbidden" }, 403);
    }
    const stored = await getSetting<VultrCloudSettings>(db, CLOUD_SETTINGS_KEY);
    return c.json({ cloud: toPublicCloudSettings(stored) });
  });

  app.post("/api/settings/cloud/vultr/connect", async (c) => {
    const user = c.get("user");
    if (!user || !can(user.role, "settings.llm")) {
      return c.json({ error: "forbidden" }, 403);
    }
    const clientId = process.env.PLAYON_VULTR_CLIENT_ID?.trim();
    if (!clientId) {
      return c.json(
        {
          error: "vultr_oauth_not_configured",
          hint: "Set PLAYON_VULTR_CLIENT_ID (PlayOn Vultr OAuth app) to enable Connect Vultr.",
        },
        503,
      );
    }
    const session = createVultrConnectSession();
    const existing = (await getSetting<VultrCloudSettings>(db, CLOUD_SETTINGS_KEY)) ?? {};
    await setSetting(db, CLOUD_SETTINGS_KEY, {
      ...existing,
      connectState: session.state,
      codeVerifier: session.codeVerifier,
    } satisfies VultrCloudSettings);
    const installCallback = `http://${config.advertiseHost}:${config.port}/api/settings/cloud/vultr/callback`;
    const authorizeUrl = buildVultrAuthorizeUrl({
      session,
      relayBase: process.env.PLAYON_VULTR_RELAY?.trim() || DEFAULT_VULTR_RELAY,
      installCallback,
      clientId,
    });
    return c.json({ authorizeUrl, state: session.state });
  });

  app.post("/api/settings/cloud/vultr/callback", async (c) => {
    // Relay or loopback posts { state, code } — not a browser cookie session.
    const body = z
      .object({
        state: z.string().min(1),
        code: z.string().min(1),
      })
      .parse(await c.req.json());
    const stored = await getSetting<VultrCloudSettings>(db, CLOUD_SETTINGS_KEY);
    if (!stored?.connectState || stored.connectState !== body.state || !stored.codeVerifier) {
      return c.json({ error: "invalid_state" }, 400);
    }
    const clientId = process.env.PLAYON_VULTR_CLIENT_ID?.trim();
    if (!clientId) return c.json({ error: "vultr_oauth_not_configured" }, 503);
    const redirectUri = `${(process.env.PLAYON_VULTR_RELAY?.trim() || DEFAULT_VULTR_RELAY).replace(/\/$/, "")}/callback`;
    try {
      const tokens = await exchangeVultrCode({
        code: body.code,
        codeVerifier: stored.codeVerifier,
        redirectUri,
        clientId,
        clientSecret: process.env.PLAYON_VULTR_CLIENT_SECRET?.trim(),
      });
      await setSetting(db, CLOUD_SETTINGS_KEY, {
        accessTokenEncrypted: encryptSecret(config.sessionSecret, tokens.accessToken),
        refreshTokenEncrypted: encryptSecret(config.sessionSecret, tokens.refreshToken),
        expiresAt: tokens.expiresAt,
      } satisfies VultrCloudSettings);
      return c.json({ ok: true, cloud: toPublicCloudSettings(await getSetting(db, CLOUD_SETTINGS_KEY)) });
    } catch (err) {
      return c.json(
        { error: err instanceof Error ? err.message : "vultr_exchange_failed" },
        400,
      );
    }
  });

  app.delete("/api/settings/cloud/vultr", async (c) => {
    const user = c.get("user");
    if (!user || !can(user.role, "settings.llm")) {
      return c.json({ error: "forbidden" }, 403);
    }
    await setSetting(db, CLOUD_SETTINGS_KEY, {} satisfies VultrCloudSettings);
    return c.json({ ok: true, cloud: toPublicCloudSettings(null) });
  });

  app.get("/api/skills/catalog", async (c) => {
    const user = c.get("user");
    if (!user || !roleAtLeast(user.role, "operator")) {
      return c.json({ error: "forbidden" }, 403);
    }
    const stored = await getSetting<SkillsCatalogSettings>(db, SKILLS_CATALOG_KEY);
    const catalogUrl = resolveSkillsCatalogUrl(
      process.env.PLAYON_SKILLS_CATALOG_URL,
      stored?.catalogUrl,
    );
    const q = c.req.query("q")?.trim() || "";
    try {
      const fetched = await fetchSkillsCatalogDetailed(catalogUrl);
      const skills = annotateCatalogInstalled(
        searchCatalog(fetched.skills, q),
        config.skillsRoots,
      );
      return c.json({
        catalogUrl,
        skills,
        warnings: fetched.warnings,
        updatedAt: fetched.updatedAt,
      });
    } catch (err) {
      return c.json(
        {
          catalogUrl,
          skills: [],
          warnings: [],
          error: err instanceof Error ? err.message : "catalog_unavailable",
        },
        502,
      );
    }
  });

  app.post("/api/skills/install-from-catalog", async (c) => {
    const user = c.get("user");
    if (!user || !can(user.role, "skills.package")) {
      return c.json({ error: "forbidden" }, 403);
    }
    try {
      const body = z
        .object({
          name: z.string().min(1).optional(),
          downloadUrl: z.string().url().optional(),
          overwrite: z.boolean().optional(),
        })
        .parse(await c.req.json());
      if (!body.name && !body.downloadUrl) {
        return c.json({ error: "name_or_downloadUrl_required" }, 400);
      }
      const stored = await getSetting<SkillsCatalogSettings>(db, SKILLS_CATALOG_KEY);
      const catalogUrl = resolveSkillsCatalogUrl(
        process.env.PLAYON_SKILLS_CATALOG_URL,
        stored?.catalogUrl,
      );
      const result = await installSkillFromCatalog({
        config,
        skillPackages,
        catalogUrl,
        name: body.name,
        downloadUrl: body.downloadUrl,
        overwrite: body.overwrite,
      });
      return c.json({
        skill: {
          skillName: result.skillName,
          path: result.path,
          version: result.version,
        },
        catalogUrl: result.catalogUrl,
        downloadUrl: result.downloadUrl,
        sha256: result.sha256,
        installed: result.installed,
        skippedDeps: result.skippedDeps,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "catalog_install_failed";
      const status = message.startsWith("skill_exists")
        ? 409
        : message.startsWith("catalog_skill_not_found")
          ? 404
          : message.startsWith("catalog_sha256")
            ? 400
            : message.startsWith("skills_catalog_fetch")
              ? 502
              : 400;
      return c.json({ error: message }, status);
    }
  });

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
      const source = classifySkillSource(s, config.dataRoot, serverId);
      return {
        id: s.id,
        name: s.metadata.name,
        version: s.metadata.version,
        game: s.metadata.game,
        description: s.metadata.description,
        tags: s.metadata.tags,
        theme: s.metadata.theme ?? null,
        containerSupport: s.metadata.containerSupport,
        dependencies: s.metadata.dependencies,
        minRamMb: s.metadata.minRamMb,
        source,
        scope: source === "server" ? ("server" as const) : ("global" as const),
      };
    });
    return c.json({ skills });
  });

  app.get("/api/skills/drafts", async (c) => {
    const user = c.get("user");
    if (!user || !roleAtLeast(user.role, "operator")) {
      return c.json({ error: "forbidden" }, 403);
    }
    const drafts = draftService.list().map((d) => {
      const entry = loadSkillMetadata(config.skillsRoots, d.skillName);
      return {
        slug: d.slug,
        skillName: d.skillName,
        path: d.path,
        version: entry?.metadata.version ?? "0.0.1-draft",
        game: entry?.metadata.game,
        description: entry?.metadata.description ?? "",
        tags: entry?.metadata.tags ?? ["draft"],
        containerSupport: entry?.metadata.containerSupport ?? "none",
      };
    });
    return c.json({ drafts });
  });

  app.post("/api/skills/drafts/:slug/promote", async (c) => {
    const user = c.get("user");
    if (!user || !can(user.role, "skills.package")) {
      return c.json({ error: "forbidden" }, 403);
    }
    try {
      const promoted = draftService.promote(decodeURIComponent(c.req.param("slug")));
      return c.json({ skill: promoted });
    } catch (err) {
      const message = err instanceof Error ? err.message : "promote_failed";
      const status = message.startsWith("unknown_draft")
        ? 404
        : message.startsWith("skill_exists")
          ? 409
          : 400;
      return c.json({ error: message }, status);
    }
  });

  app.get("/api/skills/:name/fs", async (c) => {
    const user = c.get("user");
    if (!user || !roleAtLeast(user.role, "operator")) {
      return c.json({ error: "forbidden" }, 403);
    }
    const name = decodeURIComponent(c.req.param("name"));
    const relPath = c.req.query("path")?.trim() || ".";
    try {
      const entries = skillFs.list(name, relPath);
      const writable = skillFs.isWritable(name) && can(user.role, "skills.package");
      return c.json({
        path: relPath,
        entries,
        writable,
        source: skillFs.source(name),
      });
    } catch (err) {
      return c.json(
        { error: err instanceof Error ? err.message : "fs_list_failed" },
        skillFsHttpStatus(err),
      );
    }
  });

  app.get("/api/skills/:name/fs/content", async (c) => {
    const user = c.get("user");
    if (!user || !roleAtLeast(user.role, "operator")) {
      return c.json({ error: "forbidden" }, 403);
    }
    const name = decodeURIComponent(c.req.param("name"));
    const relPath = c.req.query("path")?.trim();
    if (!relPath) return c.json({ error: "path_required" }, 400);
    try {
      const file = skillFs.read(name, relPath);
      return c.json({
        path: file.path,
        content: file.content,
        size: file.size,
        truncated: file.truncated,
        bytesRead: file.bytesRead,
        writable: file.writable && can(user.role, "skills.package"),
        source: file.source,
      });
    } catch (err) {
      return c.json(
        { error: err instanceof Error ? err.message : "fs_read_failed" },
        skillFsHttpStatus(err),
      );
    }
  });

  app.put("/api/skills/:name/fs/content", async (c) => {
    const user = c.get("user");
    if (!user || !can(user.role, "skills.package")) {
      return c.json({ error: "forbidden" }, 403);
    }
    const name = decodeURIComponent(c.req.param("name"));
    const body = (await c.req.json().catch(() => null)) as {
      path?: unknown;
      content?: unknown;
    } | null;
    const relPath = typeof body?.path === "string" ? body.path.trim() : "";
    if (!relPath) return c.json({ error: "path_required" }, 400);
    if (typeof body?.content !== "string") return c.json({ error: "content_required" }, 400);
    try {
      const written = skillFs.write(name, relPath, body.content);
      return c.json(written);
    } catch (err) {
      return c.json(
        { error: err instanceof Error ? err.message : "fs_write_failed" },
        skillFsHttpStatus(err),
      );
    }
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

  app.get("/api/skills/:name", async (c) => {
    const user = c.get("user");
    if (!user || !roleAtLeast(user.role, "operator")) {
      return c.json({ error: "forbidden" }, 403);
    }
    const name = decodeURIComponent(c.req.param("name"));
    const entry = loadSkillMetadata(config.skillsRoots, name);
    if (!entry) return c.json({ error: "unknown_skill" }, 404);
    const source = classifySkillSource(entry, config.dataRoot);
    const localNames = new Set(listSkills(config.skillsRoots).map((s) => s.metadata.name));
    const dependencies = (entry.metadata.dependencies ?? []).map((dep) => ({
      name: dep,
      present: localNames.has(dep),
    }));
    return c.json({
      skill: {
        id: entry.id,
        path: entry.path,
        source,
        metadata: entry.metadata,
        dependencies,
      },
    });
  });

  app.delete("/api/skills/:name", async (c) => {
    const user = c.get("user");
    if (!user || !can(user.role, "skills.package")) {
      return c.json({ error: "forbidden" }, 403);
    }
    const name = decodeURIComponent(c.req.param("name"));
    const force =
      c.req.query("force") === "1" ||
      c.req.query("force") === "true";
    try {
      const servers = await serverService.list();
      const inUse = servers
        .filter((s) => readSkillMarker(s.dataPath)?.skillName === name)
        .map((s) => ({ id: s.id, name: s.name }));
      if (inUse.length && !force) {
        return c.json(
          { error: "skill_in_use", servers: inUse },
          409,
        );
      }
      const removed = skillPackages.uninstall(name);
      return c.json({ ok: true, skill: removed, servers: inUse });
    } catch (err) {
      const message = err instanceof Error ? err.message : "uninstall_failed";
      const status = message.startsWith("unknown_skill")
        ? 404
        : message.startsWith("skill_not_uninstallable")
          ? 400
          : 400;
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
    requireRole(c, "operator");
    const list = await serverService.list();
    return c.json({
      servers: list,
      advertiseHost: config.advertiseHost,
      runtimeMode: config.runtimeMode,
    });
  });

  app.get("/api/servers/:id", async (c) => {
    requireRole(c, "operator");
    const detail = await serverService.detail(c.req.param("id"));
    if (!detail) throw HttpError.notFound("not_found", { code: "server_not_found" });
    return c.json(detail);
  });

  app.get("/api/servers/:id/fs", async (c) => {
    const user = c.get("user");
    if (!user || !roleAtLeast(user.role, "operator")) {
      return c.json({ error: "forbidden" }, 403);
    }
    const serverId = c.req.param("id");
    const server = await serverService.get(serverId);
    if (!server) return c.json({ error: "not_found" }, 404);
    const relPath = c.req.query("path")?.trim() || ".";
    try {
      const entries = await serverFs.list(serverId, relPath);
      return c.json({ path: relPath, entries, writable: can(user.role, "servers.manage") });
    } catch (err) {
      const message = err instanceof Error ? err.message : "fs_list_failed";
      const status = message.startsWith("not_found")
        ? 404
        : message.startsWith("unknown_server")
          ? 404
          : 400;
      return c.json({ error: message }, status);
    }
  });

  app.get("/api/servers/:id/fs/content", async (c) => {
    const user = c.get("user");
    if (!user || !roleAtLeast(user.role, "operator")) {
      return c.json({ error: "forbidden" }, 403);
    }
    const serverId = c.req.param("id");
    const server = await serverService.get(serverId);
    if (!server) return c.json({ error: "not_found" }, 404);
    const relPath = c.req.query("path")?.trim();
    if (!relPath) return c.json({ error: "path_required" }, 400);
    try {
      const file = await serverFs.read(serverId, relPath);
      return c.json({
        path: file.path,
        content: file.content,
        size: file.size,
        truncated: file.truncated,
        bytesRead: file.bytesRead,
        writable: can(user.role, "servers.manage"),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "fs_read_failed";
      const status = message.startsWith("not_found")
        ? 404
        : message.startsWith("unknown_server")
          ? 404
          : 400;
      return c.json({ error: message }, status);
    }
  });

  app.put("/api/servers/:id/fs/content", async (c) => {
    const user = c.get("user");
    if (!user || !can(user.role, "servers.manage")) {
      return c.json({ error: "forbidden" }, 403);
    }
    const serverId = c.req.param("id");
    const server = await serverService.get(serverId);
    if (!server) return c.json({ error: "not_found" }, 404);
    const body = (await c.req.json().catch(() => null)) as {
      path?: unknown;
      content?: unknown;
    } | null;
    const relPath = typeof body?.path === "string" ? body.path.trim() : "";
    if (!relPath) return c.json({ error: "path_required" }, 400);
    if (typeof body?.content !== "string") return c.json({ error: "content_required" }, 400);
    try {
      const written = await serverFs.write(serverId, relPath, body.content);
      return c.json(written);
    } catch (err) {
      const message = err instanceof Error ? err.message : "fs_write_failed";
      const status = message.startsWith("not_found")
        ? 404
        : message.startsWith("unknown_server")
          ? 404
          : 400;
      return c.json({ error: message }, status);
    }
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

  app.get("/api/watchers", async (c) => {
    const user = c.get("user");
    if (!user || !can(user.role, "watchers.read")) {
      return c.json({ error: "forbidden" }, 403);
    }
    const serverId = c.req.query("serverId") || undefined;
    return c.json({ watchers: await watcherService.list(serverId) });
  });

  app.get("/api/servers/:id/watchers", async (c) => {
    const user = c.get("user");
    if (!user || !can(user.role, "watchers.read")) {
      return c.json({ error: "forbidden" }, 403);
    }
    return c.json({ watchers: await watcherService.list(c.req.param("id")) });
  });

  app.get("/api/watchers/:id", async (c) => {
    const user = c.get("user");
    if (!user || !can(user.role, "watchers.read")) {
      return c.json({ error: "forbidden" }, 403);
    }
    const watcher = await watcherService.get(c.req.param("id"));
    if (!watcher) return c.json({ error: "not_found" }, 404);
    return c.json({ watcher });
  });

  app.post("/api/watchers", async (c) => {
    const user = c.get("user");
    if (!user || !can(user.role, "watchers.manage")) {
      return c.json({ error: "forbidden" }, 403);
    }
    try {
      const body = CreateWatcherSchema.parse(await c.req.json());
      const watcher = await watcherService.create(body);
      return c.json({ watcher }, 201);
    } catch (err) {
      const message = err instanceof Error ? err.message : "create_failed";
      return c.json({ error: message }, 400);
    }
  });

  app.patch("/api/watchers/:id", async (c) => {
    const user = c.get("user");
    if (!user || !can(user.role, "watchers.manage")) {
      return c.json({ error: "forbidden" }, 403);
    }
    try {
      const body = UpdateWatcherSchema.parse(await c.req.json());
      const watcher = await watcherService.update(c.req.param("id"), body);
      if (!watcher) return c.json({ error: "not_found" }, 404);
      return c.json({ watcher });
    } catch (err) {
      const message = err instanceof Error ? err.message : "update_failed";
      return c.json({ error: message }, 400);
    }
  });

  app.delete("/api/watchers/:id", async (c) => {
    const user = c.get("user");
    if (!user || !can(user.role, "watchers.manage")) {
      return c.json({ error: "forbidden" }, 403);
    }
    const ok = await watcherService.delete(c.req.param("id"));
    if (!ok) return c.json({ error: "not_found" }, 404);
    return c.json({ ok: true });
  });

  app.post("/api/watchers/:id/run", async (c) => {
    const user = c.get("user");
    if (!user || !can(user.role, "watchers.manage")) {
      return c.json({ error: "forbidden" }, 403);
    }
    const watcher = await watcherService.get(c.req.param("id"));
    if (!watcher) return c.json({ error: "not_found" }, 404);
    await watcherEngine.enqueue(watcher, { kind: "manual" }, { force: true });
    return c.json({ ok: true, watcherId: watcher.id, queued: true });
  });

  app.get("/api/watchers/:id/runs", async (c) => {
    const user = c.get("user");
    if (!user || !can(user.role, "watchers.read")) {
      return c.json({ error: "forbidden" }, 403);
    }
    const watcher = await watcherService.get(c.req.param("id"));
    if (!watcher) return c.json({ error: "not_found" }, 404);
    const limit = Number(c.req.query("limit") ?? 50);
    return c.json({ runs: await watcherService.listRuns(watcher.id, limit) });
  });

  app.post("/api/servers/:id/console", async (c) => {
    requireRole(c, "operator");
    // Deliberately lenient: a missing/non-string command becomes the
    // `empty_command` business result rather than a transport-level 400.
    const body = (await c.req.json().catch(() => null)) as { command?: unknown } | null;
    const command = typeof body?.command === "string" ? body.command : "";
    const result = await execConsoleCommand(serverService, c.req.param("id"), command);
    if (result.error === "unknown_server") {
      throw HttpError.notFound("not_found", { code: "server_not_found" });
    }
    // Business failures stay 200 so the UI can render dialect/body/hint without a throw.
    return c.json(result);
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
    requireRole(c, "operator");
    const body = await jsonBody(c, CreateServerSchema);
    try {
      const server = await serverService.createFromSkill({
        skillName: body.skillName!,
        serverName: body.serverName,
        nodeId: body.nodeId,
      });
      await playerPanel.publishForStatus(server.id, "stopped");
      return c.json({ server });
    } catch (err) {
      throw serviceHttpError(err, { fallback: "create_failed", code: "server_create_failed" });
    }
  });

  app.post("/api/servers/import", async (c) => {
    requireCan(c, "servers.manage");
    const body = await jsonBody(c, ImportLocalServerRequestSchema);
    try {
      const report = await importLocal.importFromPath(body);
      await playerPanel.publishForStatus(report.server.id, "stopped");
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
      throw serviceHttpError(err, { fallback: "import_failed", code: "server_import_failed" });
    }
  });

  app.post("/api/servers/import/sftp", async (c) => {
    requireCan(c, "servers.manage");
    const body = await jsonBody(c, ImportSftpServerRequestSchema);
    try {
      const report = await importSftp.importFromSftp(body);
      await playerPanel.publishForStatus(report.server.id, "stopped");
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
      throw serviceHttpError(err, {
        fallback: "sftp_import_failed",
        code: "server_sftp_import_failed",
      });
    }
  });

  /**
   * Shared tail of start/restart: publish the running panel with whatever the
   * live query could reach, then answer with the server plus its runtime view.
   */
  const runningServerResponse = async <T extends { id: string }>(server: T) => {
    const live = await safeQueryLive(
      (id) => queryService.queryServerWithRetry(id, { attempts: 5, delayMs: 1200 }),
      server.id,
    );
    await playerPanel.publishForStatus(server.id, "running", live);
    const detail = await serverService.detail(server.id);
    return { server, runtime: detail?.runtime };
  };

  app.post("/api/servers/:id/start", async (c) => {
    requireRole(c, "operator");
    try {
      const server = await serverService.start(c.req.param("id"));
      return c.json(await runningServerResponse(server));
    } catch (err) {
      throw serviceHttpError(err, { fallback: "start_failed", code: "server_start_failed" });
    }
  });

  app.post("/api/servers/:id/stop", async (c) => {
    requireRole(c, "operator");
    try {
      const server = await serverService.stop(c.req.param("id"));
      await playerPanel.publishForStatus(server.id, "stopped");
      return c.json({ server });
    } catch (err) {
      throw serviceHttpError(err, { fallback: "stop_failed", code: "server_stop_failed" });
    }
  });

  app.delete("/api/servers/:id", async (c) => {
    requireCan(c, "servers.manage");
    try {
      const removed = await serverService.remove(c.req.param("id"));
      await panelService.clearForServer(removed.id);
      return c.json({ ok: true, removed });
    } catch (err) {
      throw serviceHttpError(err, {
        fallback: "delete_failed",
        code: "server_delete_failed",
        notFoundPrefixes: ["unknown_server"],
      });
    }
  });

  app.post("/api/servers/:id/restart", async (c) => {
    requireRole(c, "operator");
    try {
      const server = await serverService.restart(c.req.param("id"));
      return c.json(await runningServerResponse(server));
    } catch (err) {
      throw serviceHttpError(err, { fallback: "restart_failed", code: "server_restart_failed" });
    }
  });

  app.post("/api/servers/:id/relocate", async (c) => {
    requireCan(c, "servers.manage");
    const body = await jsonBody(c, RelocateServerRequestSchema);
    try {
      const result = await migrateService.relocate(c.req.param("id"), body.targetNodeId);
      await playerPanel.publishForStatus(
        result.server.id,
        result.server.status === "running" ? "running" : "stopped",
      );
      return c.json({ relocate: result });
    } catch (err) {
      throw serviceHttpError(err, {
        fallback: "relocate_failed",
        code: "server_relocate_failed",
        notFoundPrefixes: ["unknown_server", "unknown_node"],
      });
    }
  });


  app.get("/api/panel", async (c) => {
    const serverId = c.req.query("serverId");
    const blocks = await playerPanel.listForPlayers(serverId);
    const theme = playerPanel.resolveTheme(blocks);
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
    const nodeSettings = await getSetting<NodeSettings>(db, NODE_SETTINGS_KEY);
    return c.json({
      localComputeEnabled: nodeSettings?.localComputeEnabled ?? true,
      wireguardTools: tunnel.toolsAvailable(),
      /** True when PLAYON_NODE_TOKEN is set — required to add LAN/cloud nodes. */
      nodeTokenConfigured: Boolean(config.nodeToken?.trim()),
      nodes: list.map((n) => {
        const kind = (n.kind as NodeKind) || (n.id === LOCAL_NODE_ID ? "local" : "lan");
        return {
          id: n.id,
          name: n.name,
          os: n.os,
          docker: n.docker,
          native: n.native ?? true,
          steamcmd: n.steamcmd ?? false,
          freeDiskBytes: n.freeDiskBytes,
          agentVersion: n.agentVersion,
          lastSeenAt: n.lastSeenAt.toISOString(),
          status: deriveNodePresence(n.lastSeenAt, now),
          kind,
          placement: placementFromNodeKind(kind),
          badge: placementBadge({
            kind,
            name: n.name,
            tunnelStatus: n.tunnelStatus,
          }),
          tunnelStatus: n.tunnelStatus,
          overlayIp: n.overlayIp,
          tunnelEndpoint: n.tunnelEndpoint,
          joinHost: n.joinHost ?? null,
        };
      }),
    });
  });

  app.get("/api/settings/nodes", async (c) => {
    const user = c.get("user");
    if (!user || !can(user.role, "settings.llm")) {
      return c.json({ error: "forbidden" }, 403);
    }
    const stored = await getSetting<NodeSettings>(db, NODE_SETTINGS_KEY);
    return c.json({ nodes: toPublicNodeSettings(stored) });
  });

  app.put("/api/settings/nodes", async (c) => {
    const user = c.get("user");
    if (!user || !can(user.role, "settings.llm")) {
      return c.json({ error: "forbidden" }, 403);
    }
    const body = z
      .object({ localComputeEnabled: z.boolean() })
      .parse(await c.req.json());
    const existing =
      (await getSetting<NodeSettings>(db, NODE_SETTINGS_KEY)) ?? DEFAULT_NODE_SETTINGS;
    await setSetting(db, NODE_SETTINGS_KEY, {
      ...existing,
      localComputeEnabled: body.localComputeEnabled,
    } satisfies NodeSettings);
    return c.json({
      nodes: toPublicNodeSettings(await getSetting(db, NODE_SETTINGS_KEY)),
    });
  });

  app.post("/api/nodes/add", async (c) => {
    const user = c.get("user");
    if (!user || !can(user.role, "servers.manage")) {
      return c.json({ error: "forbidden" }, 403);
    }
    try {
      const body = z
        .object({
          kind: z.enum(["lan", "cloud"]),
          host: z.string().min(1),
          port: z.number().int().positive().optional(),
          username: z.string().min(1),
          password: z.string().optional(),
          privateKey: z.string().optional(),
          nodeId: z.string().min(1).optional(),
          nodeName: z.string().min(1).optional(),
          wgListenPort: z.number().int().positive().optional(),
        })
        .parse(await c.req.json());
      const result = await addNode.addViaSsh(body);
      return c.json({ node: result });
    } catch (err) {
      const message = err instanceof Error ? err.message : "add_node_failed";
      return c.json({ error: message }, 400);
    }
  });

  app.post("/api/nodes/bootstrap-token", async (c) => {
    const user = c.get("user");
    if (!user || !can(user.role, "servers.manage")) {
      return c.json({ error: "forbidden" }, 403);
    }
    try {
      const body = z
        .object({
          kind: z.enum(["lan", "cloud"]),
          nodeId: z.string().min(1).optional(),
          nodeName: z.string().min(1).optional(),
          endpointHost: z.string().min(1).optional(),
        })
        .parse(await c.req.json());
      const result = await addNode.createBootstrapToken(body);
      return c.json(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : "bootstrap_token_failed";
      return c.json({ error: message }, 400);
    }
  });

  app.get("/api/nodes/bootstrap/:token", async (c) => {
    try {
      const script = await addNode.scriptForToken(c.req.param("token"));
      return c.text(script, 200, {
        "content-type": "text/x-shellscript; charset=utf-8",
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "bootstrap_failed";
      return c.text(`#!/bin/bash\necho ${JSON.stringify(message)} >&2\nexit 1\n`, 400);
    }
  });

  app.delete("/api/nodes/:nodeId", async (c) => {
    const user = c.get("user");
    if (!user || !can(user.role, "servers.manage")) {
      return c.json({ error: "forbidden" }, 403);
    }
    try {
      const force = c.req.query("force") === "1" || c.req.query("force") === "true";
      const result = await addNode.removeNode(c.req.param("nodeId"), { force });
      return c.json(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : "remove_node_failed";
      const status = message.startsWith("unknown_node") ? 404 : 400;
      return c.json({ error: message }, status);
    }
  });

  app.post("/api/nodes/:nodeId/manage/suggest", async (c) => {
    const user = c.get("user");
    if (!user || !can(user.role, "servers.manage")) {
      return c.json({ error: "forbidden" }, 403);
    }
    try {
      const result = await manageSuggest.suggest(c.req.param("nodeId"));
      return c.json(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : "manage_suggest_failed";
      const status =
        message.startsWith("unknown_node") ? 404 : message.startsWith("node_not_online") ? 409 : 400;
      return c.json({ error: message }, status);
    }
  });

  app.post("/api/nodes/:nodeId/manage", async (c) => {
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
          hintIds: z.array(z.string().min(1)).optional(),
        })
        .parse(await c.req.json());
      const report = await manageSuggest.manageFromNode({
        nodeId: c.req.param("nodeId"),
        ...body,
      });
      await playerPanel.publishForStatus(report.server.id, "stopped");
      return c.json({
        manage: {
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
      const message = err instanceof Error ? err.message : "manage_failed";
      const status =
        message.startsWith("unknown_node") ? 404 : message.startsWith("node_not_online") ? 409 : 400;
      return c.json({ error: message }, status);
    }
  });

  app.post("/api/nodes/:nodeId/install-docker", async (c) => {
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
          password: z.string().optional(),
          privateKey: z.string().optional(),
        })
        .parse(await c.req.json());
      const result = await installDocker.installViaSsh({
        nodeId: c.req.param("nodeId"),
        ...body,
      });
      return c.json(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : "install_docker_failed";
      const status = message.startsWith("unknown_node") ? 404 : 400;
      return c.json({ error: message }, status);
    }
  });

  app.post("/api/nodes/:nodeId/install-docker/token", async (c) => {
    const user = c.get("user");
    if (!user || !can(user.role, "servers.manage")) {
      return c.json({ error: "forbidden" }, 403);
    }
    try {
      const result = await installDocker.createToken(c.req.param("nodeId"));
      return c.json(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : "install_docker_token_failed";
      const status = message.startsWith("unknown_node") ? 404 : 400;
      return c.json({ error: message }, status);
    }
  });

  app.get("/api/nodes/:nodeId/install-docker/:token", async (c) => {
    try {
      const script = await installDocker.scriptForToken(
        c.req.param("nodeId"),
        c.req.param("token"),
      );
      return c.text(script, 200, {
        "content-type": "text/x-shellscript; charset=utf-8",
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "install_docker_failed";
      return c.text(`#!/bin/bash\necho ${JSON.stringify(message)} >&2\nexit 1\n`, 400);
    }
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
    const skills = await agentProgress.listSkills();
    return c.json({
      agent: { name: "Agent" },
      skills: skills.map((s) => ({
        skill: s.skill,
        xp: s.xp,
        level: s.level,
        title: s.title,
        updatedAt: s.updatedAt.toISOString(),
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
    // Protocol skew guard: remember what this agent says it can execute.
    nodeJobService.advertiseJobKinds(body.nodeId, body.jobKinds);
    const now = new Date();
    const existing = await db.select().from(nodes).where(eq(nodes.id, body.nodeId)).limit(1);
    const kind: NodeKind =
      body.kind ??
      (existing[0]?.kind as NodeKind | undefined) ??
      (body.nodeId === LOCAL_NODE_ID ? "local" : "lan");
    if (existing[0]) {
      const keepName =
        existing[0].name &&
        existing[0].name !== body.nodeId &&
        body.name === body.nodeId
          ? existing[0].name
          : body.name;
      await db
        .update(nodes)
        .set({
          name: keepName,
          os: body.os,
          docker: body.docker,
          native: body.native ?? true,
          steamcmd: body.steamcmd ?? false,
          freeDiskBytes: body.freeDiskBytes ?? null,
          agentVersion: body.agentVersion,
          lastSeenAt: now,
          kind,
          // Cloud: heartbeat implies overlay path is usable
          ...(kind === "cloud" && existing[0].tunnelStatus === "pending"
            ? { tunnelStatus: "up" }
            : {}),
        })
        .where(eq(nodes.id, body.nodeId));
    } else {
      await db.insert(nodes).values({
        id: body.nodeId,
        name: body.name,
        os: body.os,
        docker: body.docker,
        native: body.native ?? true,
        steamcmd: body.steamcmd ?? false,
        freeDiskBytes: body.freeDiskBytes ?? null,
        agentVersion: body.agentVersion,
        lastSeenAt: now,
        kind,
        tunnelStatus: kind === "cloud" ? "up" : "none",
      });
    }

    eventHub.publish({
      type: "node.heartbeat",
      nodeId: body.nodeId,
      capabilities: {
        os: body.os,
        docker: body.docker,
        native: body.native ?? true,
        steamcmd: body.steamcmd ?? false,
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
        kind: NodeJobKindSchema,
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
    await db.insert(messages).values({
      id: nanoid(),
      conversationId,
      role: "user",
      content: body.message,
      createdAt: now,
    });

    const toolSurface = createPlayOnToolSurface(plane, { workspaceServerId });

    /** Mutable: unbound create binds activity to the new server mid-turn. */
    let activityServerId = workspaceServerId;
    let activitySkill = "orchestrator";
    const publishActivity = (
      phase: "thinking" | "tool_start" | "tool_done" | "tool_fail" | "confirm_wait" | "idle",
      opts?: {
        toolName?: string;
        verb?: ReturnType<typeof verbForTool>;
        label?: string;
        skill?: string;
      },
    ) => {
      if (!activityServerId) return;
      const verb = opts?.verb ?? "other";
      if (opts?.skill) activitySkill = opts.skill;
      else if (opts?.toolName) activitySkill = toolSurface.skill(opts.toolName);
      eventHub.publish({
        type: "agent.activity",
        serverId: activityServerId,
        conversationId,
        skill: activitySkill,
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

    const abortSignal = c.req.raw.signal;
    let streamedReply = "";
    const onClientAbort = () => {
      confirmService.cancelAll();
    };
    abortSignal.addEventListener("abort", onClientAbort, { once: true });

    try {
      const llm = await createLlmClient(db, config);

      const confirmGate: ConfirmGate = {
        async requestConfirmation(request) {
          publishActivity("confirm_wait", {
            toolName: request.toolName,
            verb: verbForTool(request.toolName, toolSurface),
            label: "Waiting for confirm…",
          });
          try {
            return await confirmService.requestConfirmation(request);
          } finally {
            publishActivity("thinking", { label: "Thinking…", verb: "other" });
          }
        },
      };

      const orchestrator = createOrchestrator(plane, llm, {
        confirmGate,
        workspaceServerId,
        abortSignal,
        stream: {
          conversationId,
          onToken: (token) => {
            streamedReply += token;
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
            const verb = verbForTool(toolName, toolSurface);
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
      const result = await orchestrator.handle(body.message, priorMessages);

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
        ? await agentProgress.awardForTools(result.toolTrace, toolSurface)
        : [];
      const celebrations = awards.filter((a) => a.celebrate);
      for (const award of celebrations) {
        eventHub.publish({
          type: "agent.celebration",
          serverId: boundServerId!,
          skill: award.skill,
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
      const lastAward = awards.length ? awards[awards.length - 1] : undefined;

      return c.json({
        conversationId,
        serverId: boundServerId,
        reply: safeReply,
        llmMode: stored?.provider ?? config.llmMode,
        toolTrace: result.toolTrace,
        agentProgress: lastAward
          ? {
              skill: lastAward.progress.skill,
              xp: lastAward.progress.xp,
              level: lastAward.progress.level,
              title: lastAward.progress.title,
            }
          : undefined,
        celebrations: celebrations.map((a) => ({
          serverId: boundServerId,
          skill: a.skill,
          reason: a.reason,
          xpGained: a.xpGained,
          level: a.progress.level,
          title: a.progress.title,
          leveledUp: a.leveledUp,
        })),
      });
    } catch (err) {
      const aborted =
        err instanceof ChatAbortedError ||
        abortSignal.aborted ||
        (err instanceof Error && err.name === "AbortError");
      if (aborted) {
        confirmService.cancelAll();
        const safeReply = redactString(streamedReply.trim() || "Stopped.");
        await db.insert(messages).values({
          id: nanoid(),
          conversationId,
          role: "assistant",
          content: safeReply,
          createdAt: new Date(),
        });
        return c.json({
          conversationId,
          serverId: workspaceServerId,
          reply: safeReply,
          llmMode: config.llmMode,
          toolTrace: [],
          aborted: true,
        });
      }
      const messageText = err instanceof Error ? err.message : "chat_failed";
      console.error("chat failed:", messageText);
      const status = messageText.includes("llm_api_key_required") ? 400 : 502;
      return c.json({ error: messageText }, status);
    } finally {
      abortSignal.removeEventListener("abort", onClientAbort);
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

  const mcpHandler = createPlayOnMcpHandler(plane);
  app.all("/mcp", async (c) => {
    const rawToken = bearerFromAuthorization(c.req.header("authorization"));
    const principal = await authenticateAccessToken(db, rawToken);
    if (!principal || !rawToken) {
      return c.json({ error: "unauthorized" }, 401);
    }
    return mcpHandler.fetch(c.req.raw, {
      authInfo: authInfoFromAccessToken(rawToken, principal),
    });
  });

  const webDist =
    config.webDist ?? resolveWebDist(process.env, findRepoRoot(process.cwd()));
  mountStaticWeb(app, webDist);

  const playon = app as PlayOnApp;
  playon.injectWebSocket = injectWebSocket;
  playon.eventHub = eventHub;
  playon.confirmService = confirmService;
  playon.controlPlane = plane;
  return playon;
}
