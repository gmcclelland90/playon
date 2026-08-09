import { createHash } from "node:crypto";
import type { Server as NodeHttpServer } from "node:http";
import { createNodeWebSocket } from "@hono/node-ws";
import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { cors } from "hono/cors";
import { and, asc, count, desc, eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { z } from "zod";
import {
  AddNodeRequestSchema,
  BackupTargetRequestSchema,
  BootstrapOwnerSchema,
  ChatRequestSchema,
  ConfirmRequestSchema,
  CreateAccessTokenRequestSchema,
  CreateConversationRequestSchema,
  CreateOffNodeBackupRequestSchema,
  CreateSnapshotRequestSchema,
  CreateUserRequestSchema,
  CreateWatcherSchema,
  HttpError,
  ImportLocalServerRequestSchema,
  ImportSftpServerRequestSchema,
  ImportSkillZipRequestSchema,
  InstallDockerRequestSchema,
  InstallSkillFromCatalogRequestSchema,
  LOCAL_NODE_ID,
  LlmSettingsPutRequestSchema,
  LoginSchema,
  ManageNodeServerRequestSchema,
  NodeBootstrapTokenRequestSchema,
  NodeHeartbeatSchema,
  NodeJobKindSchema,
  NodeSettingsPutRequestSchema,
  OllamaInstallRequestSchema,
  OllamaPullRequestSchema,
  PanelInputRequestSchema,
  PromoteServerSkillRequestSchema,
  RelocateServerRequestSchema,
  RestoreOffNodeBackupRequestSchema,
  WriteServerFsContentRequestSchema,
  RoleSchema,
  UpdateWatcherSchema,
  VultrOAuthCallbackRequestSchema,
  can,
  deriveNodePresence,
  messageFromError,
  placementBadge,
  placementFromNodeKind,
  type NodeKind,
  type Role,
  type SkillInUseDetails,
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
  optionalJsonBody,
  requireCan,
  requireNodeToken,
  requireRole,
  requireSession,
  serviceHttpError,
  sessionHasRole,
} from "./http-policy.js";
import { redactJson, redactString } from "./services/redaction.js";
import { mountStaticWeb } from "./static-web.js";
import { panelUrlsFor, getPanelRuntime, setPanelRuntime } from "./services/panel-runtime.js";
import {
  beginDiscordLink,
  completeDiscordLink,
  loadHomeHostnameState,
  saveHomeHostnameState,
  syncHomeHostname,
  certIsUsable,
} from "./services/home-hostname.js";

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
import {
  serverFileStoreErrorCode,
  serverFileStoreHttpStatus,
} from "./services/server-file-store.js";
import { readSkillMarker } from "./services/skill-marker.js";
import { ConfirmService } from "./services/confirm.js";
import { EventHub } from "./services/event-hub.js";
import { safeQueryLive } from "./services/server-panel.js";
import { execConsoleCommand } from "./services/server-console.js";
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
  AgentTurnError,
  agentTurnHttpError,
} from "./services/agent-turn.js";
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

export type PlayOnApp = Hono<{ Variables: Vars }> & {
  injectWebSocket: (server: NodeHttpServer) => void;
  eventHub: EventHub;
  confirmService: ConfirmService;
  controlPlane: ControlPlane;
};

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


/**
 * Skill FS failures already carry their own status vocabulary — unknown skill,
 * jail escape, read-only source — so keep that mapping and only add the
 * envelope's per-route code.
 */
function skillFsError(err: unknown, fallback: string, code: string): HttpError {
  return new HttpError(skillFsHttpStatus(err), messageFromError(err, fallback), {
    code,
    cause: err,
  });
}

function serverFsHttpError(err: unknown, fallback: string, code: string): HttpError {
  return new HttpError(serverFileStoreHttpStatus(err), messageFromError(err, fallback), {
    code: serverFileStoreErrorCode(err, code),
    cause: err,
  });
}

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

  const hostnameState = loadHomeHostnameState(config.dataRoot);
  const corsOrigins =
    config.corsOrigins ??
    buildCorsOrigins({
      advertiseHost: config.advertiseHost,
      port: config.port,
      preferredLanPort: config.preferredLanPort ?? config.port,
      publicHostname: hostnameState?.hostname,
    });

  const sessionCookieOpts = (c: { req: { url: string } }) => {
    const url = new URL(c.req.url);
    const secure =
      url.protocol === "https:" ||
      Boolean(hostnameState?.hostname && url.hostname.endsWith(".playon.games"));
    return {
      httpOnly: true as const,
      sameSite: "Lax" as const,
      path: "/",
      secure: secure || undefined,
    };
  };

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
      const allowed = sessionHasRole(c, "operator");
      let unsubscribe: (() => void) | undefined;
      return {
        onOpen(_event, ws) {
          if (!allowed) {
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
    requireCan(c, "settings.llm");
    const force = c.req.query("force") === "1" || c.req.query("force") === "true";
    try {
      return c.json(await updateService.getStatus({ force }));
    } catch (err) {
      throw serviceHttpError(err, {
        fallback: "update_status_failed",
        code: "update_status_failed",
      });
    }
  });

  app.post("/api/updates/home/apply", async (c) => {
    requireRole(c, "owner");
    try {
      return c.json(await updateService.applyHomeUpdate());
    } catch (err) {
      throw serviceHttpError(err, {
        fallback: "update_apply_failed",
        code: "update_apply_failed",
      });
    }
  });

  app.post("/api/nodes/:nodeId/update", async (c) => {
    requireRole(c, "owner");
    try {
      return c.json(await updateService.enqueueNodeUpdate(c.req.param("nodeId")));
    } catch (err) {
      throw serviceHttpError(err, {
        fallback: "node_update_failed",
        code: "node_update_failed",
      });
    }
  });

  app.get("/api/setup", async (c) => {
    const [{ value }] = await db.select({ value: count() }).from(users);
    return c.json({ needsSetup: value === 0, product: "PlayOn" as const });
  });

  app.get("/api/panel-urls", (c) => {
    const urls = panelUrlsFor(config.advertiseHost);
    const rt = getPanelRuntime();
    const hs = rt?.hostnameState ?? loadHomeHostnameState(config.dataRoot);
    return c.json({
      ...urls,
      advertiseHost: config.advertiseHost,
      lanPort: rt?.lanPort ?? config.port,
      loopbackPort: rt?.loopbackPort ?? config.loopbackPort ?? config.port,
      mdnsAdvertised: rt?.mdnsAdvertised ?? false,
      httpsReady: Boolean(rt?.httpsListening && hs && certIsUsable(hs)),
      linkedHostname: hs?.hostname ?? null,
      discordUsername: hs?.discordUsername ?? null,
      lastError: hs?.lastError ?? null,
    });
  });

  app.post("/api/settings/panel-hostname/link/start", async (c) => {
    requireRole(c, "owner");
    const existing = loadHomeHostnameState(config.dataRoot);
    try {
      const started = await beginDiscordLink(
        { baseUrl: config.homeDnsApiUrl ?? "https://playon.games" },
        { installId: existing?.installId },
      );
      // Persist install id + device key so a restart mid-link can resume.
      saveHomeHostnameState(config.dataRoot, {
        installId: started.installId,
        deviceKey: started.deviceKey,
        hostname: existing?.hostname ?? "",
        slug: existing?.slug ?? "",
        discordUsername: existing?.discordUsername,
        certPem: existing?.certPem,
        keyPem: existing?.keyPem,
        accountKeyPem: existing?.accountKeyPem,
        certExpiresAt: existing?.certExpiresAt,
        publishedIpv4: existing?.publishedIpv4,
        updatedAt: new Date().toISOString(),
        lastError: undefined,
      });
      return c.json({
        linkUrl: started.linkUrl,
        userCode: started.userCode,
        expiresAt: started.expiresAt,
        installId: started.installId,
      });
    } catch (err) {
      throw serviceHttpError(err, {
        fallback: "panel_hostname_link_start_failed",
        code: "panel_hostname_link_start_failed",
      });
    }
  });

  app.post("/api/settings/panel-hostname/link/complete", async (c) => {
    requireRole(c, "owner");
    const body = z.object({ userCode: z.string().min(4) }).parse(await c.req.json());
    try {
      const claimed = await completeDiscordLink(
        { baseUrl: config.homeDnsApiUrl ?? "https://playon.games" },
        { userCode: body.userCode },
      );
      const prev = loadHomeHostnameState(config.dataRoot);
      const state = {
        ...prev,
        installId: claimed.installId,
        deviceKey: claimed.deviceKey,
        hostname: claimed.hostname,
        slug: claimed.slug,
        discordUsername: claimed.discordUsername,
        linkedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        lastError: undefined,
      };
      saveHomeHostnameState(config.dataRoot, state);
      const synced = await syncHomeHostname({
        dataRoot: config.dataRoot,
        api: { baseUrl: config.homeDnsApiUrl ?? "https://playon.games" },
        advertiseHost: config.advertiseHost,
      });
      const rt = getPanelRuntime();
      if (rt) {
        setPanelRuntime({
          ...rt,
          hostnameState: synced ?? state,
          httpsListening: Boolean(synced && certIsUsable(synced)),
        });
      }
      return c.json({
        ok: true,
        pending: false,
        hostname: (synced ?? state).hostname,
        urls: panelUrlsFor(config.advertiseHost),
        restartHint:
          "Restart PlayOn Home to serve HTTPS on :443 if the certificate was just issued.",
        lastError: synced?.lastError ?? null,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("not_linked_yet")) {
        return c.json({ ok: false, pending: true, error: "not_linked_yet" });
      }
      throw serviceHttpError(err, {
        fallback: "panel_hostname_link_failed",
        code: "panel_hostname_link_failed",
      });
    }
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
    setCookie(c, SESSION_COOKIE, sessionId, sessionCookieOpts(c));

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
    setCookie(c, SESSION_COOKIE, sessionId, sessionCookieOpts(c));
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
    requireCan(c, "settings.llm");
    const stored = await getSetting<LlmSettings>(db, LLM_SETTINGS_KEY);
    const settings = stored ?? { provider: config.llmMode };
    return c.json({ llm: toPublicLlmSettings(settings) });
  });

  app.put("/api/settings/llm", async (c) => {
    requireCan(c, "settings.llm");
    const body = await jsonBody(c, LlmSettingsPutRequestSchema);
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
      throw serviceHttpError(err, {
        fallback: "llm_settings_invalid",
        code: "llm_settings_invalid",
      });
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

  /** Body base URL wins, then the stored setting, then the loopback default. */
  const ollamaBaseUrl = async (fromBody?: string) => {
    const stored = await getSetting<LlmSettings>(db, LLM_SETTINGS_KEY);
    return fromBody?.trim() || stored?.baseUrl?.trim() || DEFAULT_OLLAMA_OPENAI_BASE;
  };

  app.get("/api/settings/llm/ollama/status", async (c) => {
    requireCan(c, "settings.llm");
    const baseUrl = await ollamaBaseUrl(c.req.query("baseUrl"));
    return c.json({ ollama: await probeOllama(baseUrl) });
  });

  app.post("/api/settings/llm/ollama/install", async (c) => {
    requireCan(c, "settings.llm");
    const body = await optionalJsonBody(c, OllamaInstallRequestSchema);
    const job = startOllamaInstall(await ollamaBaseUrl(body.baseUrl));
    // A refused job keeps its state in `details` so the UI can show the phase
    // that blocked it, not just the message.
    if (job.phase === "error") {
      throw HttpError.badRequest(job.message ?? "ollama_install_failed", {
        code: "ollama_install_failed",
        details: { job },
      });
    }
    return c.json({ job });
  });

  app.get("/api/settings/llm/ollama/job", async (c) => {
    requireCan(c, "settings.llm");
    return c.json({ job: getOllamaJob() });
  });

  app.post("/api/settings/llm/ollama/pull", async (c) => {
    requireCan(c, "settings.llm");
    const body = await jsonBody(c, OllamaPullRequestSchema);
    const job = startOllamaPull(await ollamaBaseUrl(body.baseUrl), body.model);
    if (job.phase === "error" && job.message === "ollama_model_required") {
      throw HttpError.badRequest(job.message, {
        code: "ollama_model_required",
        details: { job },
      });
    }
    if (job.phase === "error" && job.message === "ollama_job_busy") {
      throw HttpError.conflict(job.message, { code: "ollama_job_busy", details: { job } });
    }
    return c.json({ job });
  });

  app.get("/api/access-tokens", async (c) => {
    const user = requireCan(c, "settings.llm");
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
    const user = requireCan(c, "settings.llm");
    const body = await optionalJsonBody(c, CreateAccessTokenRequestSchema);
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
    const user = requireCan(c, "settings.llm");
    const ok = await revokeAccessToken(db, c.req.param("id"), user.id);
    if (!ok) throw HttpError.notFound("not_found", { code: "access_token_not_found" });
    return c.json({ ok: true });
  });

  app.get("/api/settings/cloud", async (c) => {
    requireCan(c, "settings.llm");
    const stored = await getSetting<VultrCloudSettings>(db, CLOUD_SETTINGS_KEY);
    return c.json({ cloud: toPublicCloudSettings(stored) });
  });

  app.post("/api/settings/cloud/vultr/connect", async (c) => {
    requireCan(c, "settings.llm");
    const clientId = process.env.PLAYON_VULTR_CLIENT_ID?.trim();
    if (!clientId) {
      // The operator has to set an env var before this can work at all, so the
      // remedy rides in `details` rather than as an ad-hoc top-level field.
      throw HttpError.unavailable("vultr_oauth_not_configured", {
        code: "vultr_oauth_not_configured",
        details: {
          hint: "Set PLAYON_VULTR_CLIENT_ID (PlayOn Vultr OAuth app) to enable Connect Vultr.",
        },
      });
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
    const body = await jsonBody(c, VultrOAuthCallbackRequestSchema);
    const stored = await getSetting<VultrCloudSettings>(db, CLOUD_SETTINGS_KEY);
    if (!stored?.connectState || stored.connectState !== body.state || !stored.codeVerifier) {
      throw HttpError.badRequest("invalid_state", { code: "invalid_state" });
    }
    const clientId = process.env.PLAYON_VULTR_CLIENT_ID?.trim();
    if (!clientId) {
      throw HttpError.unavailable("vultr_oauth_not_configured", {
        code: "vultr_oauth_not_configured",
      });
    }
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
      throw serviceHttpError(err, {
        fallback: "vultr_exchange_failed",
        code: "vultr_exchange_failed",
      });
    }
  });

  app.delete("/api/settings/cloud/vultr", async (c) => {
    requireCan(c, "settings.llm");
    await setSetting(db, CLOUD_SETTINGS_KEY, {} satisfies VultrCloudSettings);
    return c.json({ ok: true, cloud: toPublicCloudSettings(null) });
  });

  app.get("/api/skills/catalog", async (c) => {
    requireRole(c, "operator");
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
      // The catalog is an upstream we proxy, so its outage is a 502 rather than
      // a caller mistake; `details` keeps the URL that failed for support.
      throw HttpError.badGateway(messageFromError(err, "catalog_unavailable"), {
        code: "skills_catalog_unavailable",
        details: { catalogUrl },
        cause: err,
      });
    }
  });

  app.post("/api/skills/install-from-catalog", async (c) => {
    requireCan(c, "skills.package");
    const body = await jsonBody(c, InstallSkillFromCatalogRequestSchema);
    if (!body.name && !body.downloadUrl) {
      throw HttpError.badRequest("name_or_downloadUrl_required", {
        code: "name_or_downloadUrl_required",
      });
    }
    try {
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
      throw serviceHttpError(err, {
        fallback: "catalog_install_failed",
        code: "skill_catalog_install_failed",
        statusPrefixes: {
          404: ["catalog_skill_not_found"],
          409: ["skill_exists"],
          502: ["skills_catalog_fetch"],
        },
      });
    }
  });

  app.get("/api/skills", async (c) => {
    requireRole(c, "operator");
    const serverId = c.req.query("serverId") || undefined;
    if (serverId) {
      const server = await serverService.get(serverId);
      if (!server) throw HttpError.notFound("server_not_found", { code: "server_not_found" });
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
    requireRole(c, "operator");
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
    requireCan(c, "skills.package");
    try {
      const promoted = draftService.promote(decodeURIComponent(c.req.param("slug")));
      return c.json({ skill: promoted });
    } catch (err) {
      throw serviceHttpError(err, {
        fallback: "promote_failed",
        code: "skill_draft_promote_failed",
        notFoundPrefixes: ["unknown_draft"],
        statusPrefixes: { 409: ["skill_exists"] },
      });
    }
  });

  app.get("/api/skills/:name/fs", async (c) => {
    const user = requireRole(c, "operator");
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
      throw skillFsError(err, "fs_list_failed", "skill_fs_list_failed");
    }
  });

  app.get("/api/skills/:name/fs/content", async (c) => {
    const user = requireRole(c, "operator");
    const name = decodeURIComponent(c.req.param("name"));
    const relPath = c.req.query("path")?.trim();
    if (!relPath) throw HttpError.badRequest("path_required", { code: "path_required" });
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
      throw skillFsError(err, "fs_read_failed", "skill_fs_read_failed");
    }
  });

  app.put("/api/skills/:name/fs/content", async (c) => {
    requireCan(c, "skills.package");
    const name = decodeURIComponent(c.req.param("name"));
    // Deliberately lenient about the body: a missing path or content is
    // reported by field rather than as a generic schema failure.
    const body = (await c.req.json().catch(() => null)) as {
      path?: unknown;
      content?: unknown;
    } | null;
    const relPath = typeof body?.path === "string" ? body.path.trim() : "";
    if (!relPath) throw HttpError.badRequest("path_required", { code: "path_required" });
    if (typeof body?.content !== "string") {
      throw HttpError.badRequest("content_required", { code: "content_required" });
    }
    try {
      const written = skillFs.write(name, relPath, body.content);
      return c.json(written);
    } catch (err) {
      throw skillFsError(err, "fs_write_failed", "skill_fs_write_failed");
    }
  });

  app.get("/api/skills/:name/export", async (c) => {
    requireCan(c, "skills.package");
    try {
      const exported = skillPackages.exportZip(decodeURIComponent(c.req.param("name")));
      return new Response(Buffer.from(exported.bytes), {
        headers: {
          "content-type": "application/zip",
          "content-disposition": `attachment; filename="${exported.filename}"`,
        },
      });
    } catch (err) {
      throw serviceHttpError(err, {
        fallback: "export_failed",
        code: "skill_export_failed",
        notFoundPrefixes: ["unknown_skill"],
      });
    }
  });

  app.get("/api/skills/:name", async (c) => {
    requireRole(c, "operator");
    const name = decodeURIComponent(c.req.param("name"));
    const entry = loadSkillMetadata(config.skillsRoots, name);
    if (!entry) throw HttpError.notFound("unknown_skill", { code: "unknown_skill" });
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
    requireCan(c, "skills.package");
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
        // The blocking servers ride in `details` so the confirm dialog can list
        // them without a second round trip.
        throw HttpError.conflict("skill_in_use", {
          code: "skill_in_use",
          details: { servers: inUse } satisfies SkillInUseDetails,
        });
      }
      const removed = skillPackages.uninstall(name);
      return c.json({ ok: true, skill: removed, servers: inUse });
    } catch (err) {
      throw serviceHttpError(err, {
        fallback: "uninstall_failed",
        code: "skill_uninstall_failed",
        notFoundPrefixes: ["unknown_skill"],
      });
    }
  });

  app.post("/api/skills/import", async (c) => {
    requireCan(c, "skills.package");
    try {
      const contentType = c.req.header("content-type") ?? "";
      let bytes: Uint8Array;
      let overwrite = false;
      if (contentType.includes("multipart/form-data")) {
        const body = await c.req.parseBody();
        const file = body.file;
        if (!(file instanceof File)) {
          throw HttpError.badRequest("file_required", { code: "file_required" });
        }
        bytes = new Uint8Array(await file.arrayBuffer());
        overwrite = body.overwrite === "true" || body.overwrite === "1";
      } else {
        const body = await jsonBody(c, ImportSkillZipRequestSchema);
        bytes = Uint8Array.from(Buffer.from(body.zipBase64, "base64"));
        overwrite = body.overwrite ?? false;
      }
      const imported = skillPackages.importZip(bytes, { overwrite });
      return c.json({ skill: imported });
    } catch (err) {
      throw serviceHttpError(err, {
        fallback: "import_failed",
        code: "skill_import_failed",
        statusPrefixes: { 409: ["skill_exists"] },
      });
    }
  });

  app.post("/api/skills/promote-server", async (c) => {
    requireCan(c, "skills.package");
    const body = await jsonBody(c, PromoteServerSkillRequestSchema);
    try {
      const promoted = skillPackages.promoteServerSkill(body.serverId, body.skillSlug, {
        overwrite: body.overwrite,
      });
      return c.json({ skill: promoted });
    } catch (err) {
      throw serviceHttpError(err, {
        fallback: "promote_failed",
        code: "skill_promote_server_failed",
        notFoundPrefixes: ["unknown_server_skill"],
        statusPrefixes: { 409: ["skill_exists"] },
      });
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
    const user = requireRole(c, "operator");
    const serverId = c.req.param("id");
    const server = await serverService.get(serverId);
    if (!server) throw HttpError.notFound("not_found", { code: "server_not_found" });
    const relPath = c.req.query("path")?.trim() || ".";
    try {
      const entries = await (await serverService.files(serverId)).list(relPath);
      return c.json({ path: relPath, entries, writable: can(user.role, "servers.manage") });
    } catch (err) {
      throw serverFsHttpError(err, "fs_list_failed", "server_fs_list_failed");
    }
  });

  app.get("/api/servers/:id/fs/content", async (c) => {
    const user = requireRole(c, "operator");
    const serverId = c.req.param("id");
    const server = await serverService.get(serverId);
    if (!server) throw HttpError.notFound("not_found", { code: "server_not_found" });
    const relPath = c.req.query("path")?.trim();
    if (!relPath) throw HttpError.badRequest("path_required", { code: "path_required" });
    try {
      const file = await (await serverService.files(serverId)).readText(relPath);
      return c.json({
        path: file.path,
        content: file.content,
        size: file.size,
        truncated: file.truncated,
        bytesRead: file.bytesRead,
        writable: can(user.role, "servers.manage"),
      });
    } catch (err) {
      throw serverFsHttpError(err, "fs_read_failed", "server_fs_read_failed");
    }
  });

  app.put("/api/servers/:id/fs/content", async (c) => {
    requireCan(c, "servers.manage");
    const serverId = c.req.param("id");
    const server = await serverService.get(serverId);
    if (!server) throw HttpError.notFound("not_found", { code: "server_not_found" });
    const body = await jsonBody(c, WriteServerFsContentRequestSchema);
    const relPath = body.path.trim();
    try {
      const written = await (await serverService.files(serverId)).writeText(relPath, body.content);
      return c.json(written);
    } catch (err) {
      throw serverFsHttpError(err, "fs_write_failed", "server_fs_write_failed");
    }
  });

  app.get("/api/servers/:id/health", async (c) => {
    requireRole(c, "operator");
    const remediate = c.req.query("remediate") === "1" || c.req.query("remediate") === "true";
    try {
      const report = await healthService.checkServer(c.req.param("id"), { remediate });
      return c.json(report);
    } catch (err) {
      throw serviceHttpError(err, { fallback: "health_failed", code: "server_health_failed" });
    }
  });

  /** Every watcher route answers the same 404 for an id that isn't ours. */
  const requireWatcher = async (id: string) => {
    const watcher = await watcherService.get(id);
    if (!watcher) throw HttpError.notFound("not_found", { code: "watcher_not_found" });
    return watcher;
  };

  app.get("/api/watchers", async (c) => {
    requireCan(c, "watchers.read");
    const serverId = c.req.query("serverId") || undefined;
    return c.json({ watchers: await watcherService.list(serverId) });
  });

  app.get("/api/servers/:id/watchers", async (c) => {
    requireCan(c, "watchers.read");
    return c.json({ watchers: await watcherService.list(c.req.param("id")) });
  });

  app.get("/api/watchers/:id", async (c) => {
    requireCan(c, "watchers.read");
    return c.json({ watcher: await requireWatcher(c.req.param("id")) });
  });

  app.post("/api/watchers", async (c) => {
    requireCan(c, "watchers.manage");
    const body = await jsonBody(c, CreateWatcherSchema);
    try {
      const watcher = await watcherService.create(body);
      return c.json({ watcher }, 201);
    } catch (err) {
      throw serviceHttpError(err, { fallback: "create_failed", code: "watcher_create_failed" });
    }
  });

  app.patch("/api/watchers/:id", async (c) => {
    requireCan(c, "watchers.manage");
    const body = await jsonBody(c, UpdateWatcherSchema);
    try {
      const watcher = await watcherService.update(c.req.param("id"), body);
      if (!watcher) throw HttpError.notFound("not_found", { code: "watcher_not_found" });
      return c.json({ watcher });
    } catch (err) {
      throw serviceHttpError(err, { fallback: "update_failed", code: "watcher_update_failed" });
    }
  });

  app.delete("/api/watchers/:id", async (c) => {
    requireCan(c, "watchers.manage");
    const ok = await watcherService.delete(c.req.param("id"));
    if (!ok) throw HttpError.notFound("not_found", { code: "watcher_not_found" });
    return c.json({ ok: true });
  });

  app.post("/api/watchers/:id/run", async (c) => {
    requireCan(c, "watchers.manage");
    const watcher = await requireWatcher(c.req.param("id"));
    await watcherEngine.enqueue(watcher, { kind: "manual" }, { force: true });
    return c.json({ ok: true, watcherId: watcher.id, queued: true });
  });

  app.get("/api/watchers/:id/runs", async (c) => {
    requireCan(c, "watchers.read");
    const watcher = await requireWatcher(c.req.param("id"));
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

  /** Conversations are per-server, so an id that isn't ours is the same 404 everywhere. */
  const requireConversationServer = async (serverId: string) => {
    const server = await serverService.get(serverId);
    if (!server) throw HttpError.notFound("not_found", { code: "server_not_found" });
    return server;
  };

  app.get("/api/servers/:id/conversations", async (c) => {
    const user = requireCan(c, "chat.agent");
    const serverId = c.req.param("id");
    await requireConversationServer(serverId);

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
    const user = requireCan(c, "chat.agent");
    const serverId = c.req.param("id");
    await requireConversationServer(serverId);

    const body = await optionalJsonBody(c, CreateConversationRequestSchema);
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
    if (!allowPanelInput(key)) throw HttpError.rateLimited("rate_limited");
    // Panel input is unauthenticated, so anything the service throws stays
    // opaque behind the shared 500 rather than echoing internals to players.
    const body = await jsonBody(c, PanelInputRequestSchema);
    return c.json(await panelService.recordInput(body));
  });

  app.get("/api/nodes", async (c) => {
    requireRole(c, "operator");
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
    requireCan(c, "settings.llm");
    const stored = await getSetting<NodeSettings>(db, NODE_SETTINGS_KEY);
    return c.json({ nodes: toPublicNodeSettings(stored) });
  });

  app.put("/api/settings/nodes", async (c) => {
    requireCan(c, "settings.llm");
    const body = await jsonBody(c, NodeSettingsPutRequestSchema);
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
    requireCan(c, "servers.manage");
    const body = await jsonBody(c, AddNodeRequestSchema);
    try {
      return c.json({ node: await addNode.addViaSsh(body) });
    } catch (err) {
      throw serviceHttpError(err, { fallback: "add_node_failed", code: "add_node_failed" });
    }
  });

  app.post("/api/nodes/bootstrap-token", async (c) => {
    requireCan(c, "servers.manage");
    const body = await jsonBody(c, NodeBootstrapTokenRequestSchema);
    try {
      return c.json(await addNode.createBootstrapToken(body));
    } catch (err) {
      throw serviceHttpError(err, {
        fallback: "bootstrap_token_failed",
        code: "bootstrap_token_failed",
      });
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

  /** Every node route promotes an unknown id to 404 with the service's own text. */
  const NODE_NOT_FOUND = ["unknown_node"] as const;
  /** A node that is registered but not currently reachable is a 409, not a 400. */
  const NODE_OFFLINE = { 409: ["node_not_online"] } as const;

  app.delete("/api/nodes/:nodeId", async (c) => {
    requireCan(c, "servers.manage");
    const force = c.req.query("force") === "1" || c.req.query("force") === "true";
    try {
      return c.json(await addNode.removeNode(c.req.param("nodeId"), { force }));
    } catch (err) {
      throw serviceHttpError(err, {
        fallback: "remove_node_failed",
        code: "remove_node_failed",
        notFoundPrefixes: NODE_NOT_FOUND,
      });
    }
  });

  app.post("/api/nodes/:nodeId/manage/suggest", async (c) => {
    requireCan(c, "servers.manage");
    try {
      return c.json(await manageSuggest.suggest(c.req.param("nodeId")));
    } catch (err) {
      throw serviceHttpError(err, {
        fallback: "manage_suggest_failed",
        code: "manage_suggest_failed",
        notFoundPrefixes: NODE_NOT_FOUND,
        statusPrefixes: NODE_OFFLINE,
      });
    }
  });

  app.post("/api/nodes/:nodeId/manage", async (c) => {
    requireCan(c, "servers.manage");
    const body = await jsonBody(c, ManageNodeServerRequestSchema);
    try {
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
      throw serviceHttpError(err, {
        fallback: "manage_failed",
        code: "node_manage_failed",
        notFoundPrefixes: NODE_NOT_FOUND,
        statusPrefixes: NODE_OFFLINE,
      });
    }
  });

  app.post("/api/nodes/:nodeId/install-docker", async (c) => {
    requireCan(c, "servers.manage");
    const body = await jsonBody(c, InstallDockerRequestSchema);
    try {
      return c.json(
        await installDocker.installViaSsh({ nodeId: c.req.param("nodeId"), ...body }),
      );
    } catch (err) {
      throw serviceHttpError(err, {
        fallback: "install_docker_failed",
        code: "install_docker_failed",
        notFoundPrefixes: NODE_NOT_FOUND,
      });
    }
  });

  app.post("/api/nodes/:nodeId/install-docker/token", async (c) => {
    requireCan(c, "servers.manage");
    try {
      return c.json(await installDocker.createToken(c.req.param("nodeId")));
    } catch (err) {
      throw serviceHttpError(err, {
        fallback: "install_docker_token_failed",
        code: "install_docker_token_failed",
        notFoundPrefixes: NODE_NOT_FOUND,
      });
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
    requireCan(c, "servers.manage");
    const skillName = c.req.query("skillName")?.trim();
    if (!skillName) {
      throw HttpError.badRequest("skillName_required", { code: "skillName_required" });
    }
    try {
      return c.json({ placement: await placementService.plan(skillName) });
    } catch (err) {
      throw serviceHttpError(err, {
        fallback: "placement_failed",
        code: "placement_failed",
        notFoundPrefixes: ["unknown_skill"],
      });
    }
  });

  app.get("/api/snapshots", async (c) => {
    requireCan(c, "servers.manage");
    const list = await snapshotService.list(c.req.query("serverId") || undefined);
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
    requireCan(c, "servers.manage");
    const body = await jsonBody(c, CreateSnapshotRequestSchema);
    try {
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
      throw serviceHttpError(err, {
        fallback: "snapshot_failed",
        code: "snapshot_create_failed",
        notFoundPrefixes: ["unknown_server"],
      });
    }
  });

  app.post("/api/snapshots/:id/restore", async (c) => {
    requireCan(c, "snapshots.restore");
    try {
      return c.json({ server: await snapshotService.restore(c.req.param("id")) });
    } catch (err) {
      throw serviceHttpError(err, {
        fallback: "restore_failed",
        code: "snapshot_restore_failed",
        notFoundPrefixes: ["unknown_snapshot"],
      });
    }
  });

  app.get("/api/backups/target", async (c) => {
    requireCan(c, "servers.manage");
    const rootPath = await offNodeBackup.getTarget();
    return c.json({ target: rootPath ? { rootPath } : null });
  });

  app.put("/api/backups/target", async (c) => {
    requireCan(c, "settings.llm");
    const body = await jsonBody(c, BackupTargetRequestSchema);
    try {
      return c.json({ target: await offNodeBackup.setTarget(body.rootPath) });
    } catch (err) {
      throw serviceHttpError(err, {
        fallback: "backup_target_failed",
        code: "backup_target_failed",
      });
    }
  });

  app.get("/api/backups/offnode", async (c) => {
    requireCan(c, "servers.manage");
    const list = await offNodeBackup.list(c.req.query("serverId") || undefined);
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
    requireCan(c, "servers.manage");
    const body = await jsonBody(c, CreateOffNodeBackupRequestSchema);
    if (!body.snapshotId && !body.serverId) {
      throw HttpError.badRequest("serverId_or_snapshotId_required", {
        code: "serverId_or_snapshotId_required",
      });
    }
    try {
      // An explicit snapshot wins: exporting it is cheaper than taking a new one.
      const record = body.snapshotId
        ? await offNodeBackup.exportSnapshot(body.snapshotId)
        : await offNodeBackup.backupServer(body.serverId!, body.label);
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
      throw serviceHttpError(err, {
        fallback: "offnode_backup_failed",
        code: "offnode_backup_failed",
        notFoundPrefixes: ["unknown_"],
      });
    }
  });

  app.post("/api/backups/offnode/:id/restore", async (c) => {
    requireCan(c, "snapshots.restore");
    const body = await optionalJsonBody(c, RestoreOffNodeBackupRequestSchema);
    try {
      const result = await offNodeBackup.restore(c.req.param("id"), body.serverId);
      return c.json({ restore: result });
    } catch (err) {
      throw serviceHttpError(err, {
        fallback: "offnode_restore_failed",
        code: "offnode_restore_failed",
        notFoundPrefixes: ["unknown_"],
      });
    }
  });
  app.get("/api/agents", async (c) => {
    requireCan(c, "servers.manage");
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
    requireCan(c, "servers.manage");
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
    requireNodeToken(c, config.nodeToken);
    const body = await jsonBody(c, NodeHeartbeatSchema);
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
    requireNodeToken(c, config.nodeToken);
    const nodeId = c.req.param("nodeId");
    const body = await jsonBody(
      c,
      z.object({
        serverId: z.string().min(1),
        lines: z.array(z.string()).min(1).max(200),
      }),
    );

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
    requireNodeToken(c, config.nodeToken);
    const nodeId = c.req.param("nodeId");
    const body = await jsonBody(
      c,
      z.object({
        freeDiskBytes: z.number().nonnegative().optional(),
        cpuPercent: z.number().min(0).max(100).optional(),
        memUsedBytes: z.number().nonnegative().optional(),
        memTotalBytes: z.number().nonnegative().optional(),
      }),
    );

    eventHub.publish({
      type: "node.metrics",
      nodeId,
      metrics: body,
    });
    return c.json({ ok: true });
  });

  app.get("/api/nodes/:nodeId/jobs/next", async (c) => {
    requireNodeToken(c, config.nodeToken);
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
    requireNodeToken(c, config.nodeToken);
    const nodeId = c.req.param("nodeId");
    const jobId = c.req.param("jobId");
    const existing = nodeJobService.get(jobId);
    if (!existing || existing.nodeId !== nodeId) {
      throw HttpError.notFound("job_not_found", { code: "job_not_found" });
    }
    const body = await jsonBody(
      c,
      z.union([
        z.object({ ok: z.literal(true), result: z.unknown() }),
        z.object({ ok: z.literal(false), error: z.string().min(1) }),
      ]),
    );
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
    requireCan(c, "servers.manage");
    const nodeId = c.req.param("nodeId");
    const body = await jsonBody(
      c,
      z.object({
        kind: NodeJobKindSchema,
        args: z.record(z.unknown()).optional(),
      }),
    );
    const job = nodeJobService.enqueue(nodeId, body.kind, body.args ?? {});
    return c.json({ job }, 201);
  });

  app.get("/api/nodes/:nodeId/jobs/:jobId", async (c) => {
    requireCan(c, "servers.manage");
    const nodeId = c.req.param("nodeId");
    const jobId = c.req.param("jobId");
    const job = nodeJobService.get(jobId);
    if (!job || job.nodeId !== nodeId) {
      throw HttpError.notFound("job_not_found", { code: "job_not_found" });
    }
    return c.json({ job });
  });

  app.get("/api/conversations", async (c) => {
    const user = requireCan(c, "chat.agent");
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
    const user = requireCan(c, "chat.agent");

    const conversationId = c.req.param("id");
    const rows = await db
      .select()
      .from(conversations)
      .where(eq(conversations.id, conversationId))
      .limit(1);
    const conversation = rows[0];
    if (!conversation) {
      throw HttpError.notFound("not_found", { code: "conversation_not_found" });
    }
    // Someone else's transcript reads as forbidden, not as a missing id.
    if (conversation.userId !== user.id) throw HttpError.forbidden("forbidden");

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
    const user = requireCan(c, "chat.agent");
    const body = await jsonBody(c, ChatRequestSchema);
    const prompt = body.message?.trim() ? body.message : null;
    if (!prompt) throw HttpError.badRequest("message_required", { code: "message_required" });

    try {
      const result = await plane.agentTurn.run({
        source: "chat",
        userId: user.id,
        prompt,
        conversationId: body.conversationId,
        serverId: body.serverId,
        abortSignal: c.req.raw.signal,
      });
      return c.json({
        conversationId: result.conversationId,
        serverId: result.serverId,
        reply: result.reply,
        llmMode: result.llmMode,
        toolTrace: result.toolTrace,
        aborted: result.aborted,
        agentProgress: result.agentProgress,
        celebrations: result.celebrations,
      });
    } catch (err) {
      if (err instanceof AgentTurnError) {
        if (err.code === "chat_failed" || err.code === "llm_api_key_required") {
          console.error("chat failed:", redactString(err.message));
        }
        throw agentTurnHttpError(err);
      }
      throw err;
    }
  });

  app.post("/api/users", async (c) => {
    requireCan(c, "users.manage");
    const body = await jsonBody(c, CreateUserRequestSchema);
    const existing = await db
      .select()
      .from(users)
      .where(eq(users.username, body.username))
      .limit(1);
    if (existing[0]) throw HttpError.conflict("username_taken", { code: "username_taken" });

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
    requireCan(c, "confirm.host");
    const body = await jsonBody(c, ConfirmRequestSchema);
    const ok = confirmService.resolve(body.requestId, body.approved);
    if (!ok) {
      throw HttpError.notFound("unknown_or_expired_request", {
        code: "unknown_or_expired_request",
      });
    }
    return c.json({ ok: true, requestId: body.requestId, approved: body.approved });
  });

  const mcpHandler = createPlayOnMcpHandler(plane);
  app.all("/mcp", async (c) => {
    const rawToken = bearerFromAuthorization(c.req.header("authorization"));
    const principal = await authenticateAccessToken(db, rawToken);
    if (!principal || !rawToken) {
      throw HttpError.unauthorized("unauthorized");
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
