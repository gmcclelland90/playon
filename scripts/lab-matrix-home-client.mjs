#!/usr/bin/env node
/**
 * Live Home client for lab-matrix Windows placement.
 * Windows node agents heartbeat/job-poll durable Home — not the matrix temp CP.
 *
 * Game actions use MCP (`/mcp`, Authorization: Bearer <access token>).
 * Node presence (`nodes_list`) and the live-server protect list (`servers_list`)
 * also use MCP, so an MCP access token is enough. A live `playon_session`
 * cookie is only a fallback. Home REST does not accept bearer tokens.
 */
import fs from "node:fs";
import path from "node:path";

const DEFAULT_API = "http://127.0.0.1:8787";
const DEFAULT_WIN_NODE = "playon-win-1";
const DEFAULT_WIN_HOST = "172.16.0.94";
const DURABLE_DB = "/home/playon/src/playon/apps/api/data/playon.db";

/** Matches `SESSION_TTL_MS` in apps/api/src/auth/session.ts (14 days). */
export const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 14;

function parseSseJson(text) {
  const lines = String(text).split(/\r?\n/);
  for (const line of lines) {
    if (line.startsWith("data: ")) {
      return JSON.parse(line.slice(6));
    }
  }
  return JSON.parse(text);
}

export function windowsPlacementConfig(repoRoot) {
  const disabled =
    process.env.PLAYON_MATRIX_WIN_NODE_ID === "off" ||
    process.env.PLAYON_MATRIX_WIN_NODE_ID === "0";
  return {
    enabled: !disabled,
    api: process.env.PLAYON_MATRIX_HOME_API?.trim() || DEFAULT_API,
    winNodeId: process.env.PLAYON_MATRIX_WIN_NODE_ID?.trim() || DEFAULT_WIN_NODE,
    winHost: process.env.PLAYON_MATRIX_WIN_HOST?.trim() || DEFAULT_WIN_HOST,
    authPath: path.join(repoRoot, "tmp", "lab-matrix-home-auth.json"),
    durableDb: process.env.PLAYON_MATRIX_HOME_DB?.trim() || DURABLE_DB,
  };
}

/** Skill needs a Windows worker (os windows-only and/or PE native.binary). */
export function wantsWindowsPlacement(meta) {
  const osList = Array.isArray(meta.os) ? meta.os : [];
  const winOnly =
    osList.length > 0 && osList.includes("windows") && !osList.includes("linux");
  const primaryBinary = String(meta.native?.binary ?? "").replace(/\\/g, "/");
  const pe = /\.exe$/i.test(primaryBinary);
  return winOnly || pe;
}

/** Same string as `@playon/shared` `playonContainerName`. */
export function defaultPlayonContainerName(serverId) {
  return `playon-${serverId}`;
}

/**
 * @returns {"absent" | "fresh" | "expired" | "unknown"}
 * `unknown` has a session string but no expiry metadata — the caller must validate it.
 */
export function cachedSessionVerdict(auth, now = Date.now()) {
  const session = typeof auth?.session === "string" ? auth.session.trim() : "";
  if (!session) return "absent";
  if (auth.sessionExpiresAt) {
    const exp = Date.parse(auth.sessionExpiresAt);
    if (!Number.isFinite(exp) || exp <= now) return "expired";
    return "fresh";
  }
  if (auth.mintedAt) {
    const minted = Date.parse(auth.mintedAt);
    if (!Number.isFinite(minted)) return "unknown";
    return minted + SESSION_TTL_MS > now ? "fresh" : "expired";
  }
  return "unknown";
}

export function isAuthMessage(message) {
  return /auth_failed|unauthorized|forbidden|home_rest_401|home_rest_403|\bHTTP 401\b|\bHTTP 403\b/i.test(
    String(message),
  );
}

/** Stable prefix for Windows placement failures. */
export function classifyPlacementFailure(message) {
  const msg = String(message);
  if (msg.startsWith("windows_node_offline")) return "windows_node_offline";
  if (msg.startsWith("windows_node_missing")) return "windows_node_missing";
  if (msg.startsWith("auth_failed") || isAuthMessage(msg)) return "auth_failed";
  return "check_failed";
}

/**
 * Human-readable placement failure. Distinguishes env-off, auth, and offline.
 * @param {string} note
 * @param {string} [nodeId]
 */
export function explainWindowsPlacementNote(note, nodeId = DEFAULT_WIN_NODE) {
  const text = String(note ?? "");
  if (text === "disabled_by_env" || text.startsWith("disabled_by_env")) {
    return `disabled_by_env: PLAYON_MATRIX_WIN_NODE_ID=off (Windows placement is turned off; ${nodeId} was not checked)`;
  }
  if (text.includes("auth_failed")) {
    return `auth_failed: Home rejected the MCP access token or session cookie while checking ${nodeId}. ${text}`;
  }
  if (text.includes("windows_node_offline")) {
    return `windows_node_offline: ${nodeId} is not online. ${text}`;
  }
  if (text.includes("windows_node_missing")) {
    return `windows_node_missing: ${nodeId} is not registered on Home. ${text}`;
  }
  return text;
}

export function nodeBoardFromPayload(payload) {
  if (!payload || typeof payload !== "object") return null;
  if (Array.isArray(payload.nodes)) return payload;
  if (payload.result && Array.isArray(payload.result.nodes)) return payload.result;
  if (payload.value && Array.isArray(payload.value.nodes)) return payload.value;
  return null;
}

export function serverRowsFromPayload(payload) {
  if (Array.isArray(payload)) return payload;
  if (payload && typeof payload === "object") {
    if (Array.isArray(payload.servers)) return payload.servers;
    if (Array.isArray(payload.result)) return payload.result;
    if (Array.isArray(payload.value)) return payload.value;
  }
  return null;
}

function errorMessage(err) {
  return err instanceof Error ? err.message : String(err);
}

function asAuthOrCheck(msg) {
  if (msg.startsWith("auth_failed") || isAuthMessage(msg)) {
    return msg.startsWith("auth_failed") ? msg : `auth_failed: ${msg}`;
  }
  return `windows_node_check_failed: ${msg}`;
}

function protectListError(err) {
  const msg = errorMessage(err);
  if (msg.startsWith("protect_list_unavailable")) {
    return err instanceof Error ? err : new Error(msg);
  }
  return new Error(
    `protect_list_unavailable: ${msg} (fail closed; live servers stay protected)`,
  );
}

async function sessionCookieValid(api, session, fetchImpl) {
  try {
    const res = await fetchImpl(`${api}/api/auth/me`, {
      method: "GET",
      headers: { Cookie: `playon_session=${session}` },
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function resolveSession(auth, { api, now, fetchImpl }) {
  const verdict = cachedSessionVerdict(auth, now);
  if (verdict === "fresh") return auth.session.trim();
  if (verdict === "absent" || verdict === "expired") return "";
  const ok = await sessionCookieValid(api, auth.session.trim(), fetchImpl);
  return ok ? auth.session.trim() : "";
}

async function mintAuth(cfg) {
  if (!fs.existsSync(cfg.durableDb)) {
    throw new Error(`durable Home db missing: ${cfg.durableDb}`);
  }
  const { createDb } = await import("../apps/api/dist/db/client.js");
  const { createSession } = await import("../apps/api/dist/auth/session.js");
  const { createAccessToken } = await import("../apps/api/dist/services/access-tokens.js");
  const { db, sqlite } = createDb(cfg.durableDb);
  try {
    const row = sqlite.prepare("select id from users where role = 'owner' limit 1").get();
    if (!row?.id) throw new Error("no owner user in durable Home db");
    const tok = await createAccessToken(db, {
      name: `lab-matrix-windows-${Date.now()}`,
      userId: row.id,
      autoApproveConfirms: true,
    });
    const session = await createSession(db, row.id);
    const exp = sqlite.prepare("select expires_at from sessions where id = ?").get(session);
    const sessionExpiresAt =
      exp?.expires_at != null
        ? new Date(Number(exp.expires_at)).toISOString()
        : new Date(Date.now() + SESSION_TTL_MS).toISOString();
    const auth = {
      token: tok.token,
      session,
      sessionExpiresAt,
      api: cfg.api,
      winNodeId: cfg.winNodeId,
      winHost: cfg.winHost,
      mintedAt: new Date().toISOString(),
    };
    fs.mkdirSync(path.dirname(cfg.authPath), { recursive: true });
    fs.writeFileSync(cfg.authPath, JSON.stringify(auth), { mode: 0o600 });
    return auth;
  } finally {
    sqlite.close();
  }
}

export async function loadHomeAuth(cfg, opts = {}) {
  const now = opts.now ?? Date.now();
  const fetchImpl = opts.fetchImpl ?? fetch;
  const envToken = process.env.PLAYON_MATRIX_HOME_TOKEN?.trim() || "";
  if (envToken) {
    const session = await resolveSession(
      { session: process.env.PLAYON_MATRIX_HOME_SESSION?.trim() || "" },
      { api: cfg.api, now, fetchImpl },
    );
    return {
      token: envToken,
      session,
      api: cfg.api,
      winNodeId: cfg.winNodeId,
      winHost: cfg.winHost,
    };
  }
  if (fs.existsSync(cfg.authPath)) {
    let stored = null;
    try {
      stored = JSON.parse(fs.readFileSync(cfg.authPath, "utf8"));
    } catch {
      stored = null;
    }
    if (stored?.token) {
      const session = await resolveSession(stored, {
        api: stored.api || cfg.api,
        now,
        fetchImpl,
      });
      return {
        ...stored,
        token: stored.token,
        session,
        api: stored.api || cfg.api,
        winNodeId: cfg.winNodeId,
        winHost: cfg.winHost,
      };
    }
  }
  return mintAuth(cfg);
}

export class HomeClient {
  constructor(auth, opts = {}) {
    this.auth = auth;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.mcpSession = null;
    this._id = 1;
    this._ready = null;
  }

  async ensureMcp() {
    if (this._ready) return this._ready;
    this._ready = (async () => {
      await this.mcp("initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "lab-matrix", version: "0.1" },
      });
      try {
        await this.mcp("notifications/initialized", {});
      } catch {
        /* notification may 202/empty */
      }
    })();
    return this._ready;
  }

  async rest(pathname, { method = "GET", body } = {}) {
    const res = await this.fetchImpl(`${this.auth.api}${pathname}`, {
      method,
      headers: {
        Cookie: `playon_session=${this.auth.session}`,
        ...(body ? { "content-type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* raw */
    }
    if (!res.ok) {
      const detail = json?.error?.message || json?.message || json?.error || text.slice(0, 300);
      throw new Error(`home_rest_${res.status}: ${pathname} ${detail}`);
    }
    return json;
  }

  async mcp(method, params) {
    const id = this._id++;
    const headers = {
      Authorization: `Bearer ${this.auth.token}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    };
    if (this.mcpSession) headers["mcp-session-id"] = this.mcpSession;
    const res = await this.fetchImpl(`${this.auth.api}/mcp`, {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
    });
    const sid = res.headers.get("mcp-session-id");
    if (sid) this.mcpSession = sid;
    const text = await res.text();
    if (!res.ok) {
      let detail = text.slice(0, 300);
      try {
        const parsed = JSON.parse(text);
        const err = parsed?.error;
        detail =
          (typeof err === "string" ? err : err?.message) || parsed?.message || detail;
      } catch {
        /* raw */
      }
      if (res.status === 401 || res.status === 403) {
        throw new Error(`auth_failed: MCP ${method} HTTP ${res.status} ${detail}`);
      }
      throw new Error(`mcp_http_${res.status}: ${method} ${detail}`);
    }
    if (!text) return null;
    const json = parseSseJson(text);
    if (json?.error) {
      const detail = typeof json.error === "string" ? json.error : JSON.stringify(json.error);
      if (isAuthMessage(detail)) {
        throw new Error(`auth_failed: mcp_${method}: ${detail}`);
      }
      throw new Error(`mcp_${method}: ${detail}`);
    }
    return json;
  }

  async tool(name, args) {
    await this.ensureMcp();
    const json = await this.mcp("tools/call", { name, arguments: args ?? {} });
    const sc = json?.result?.structuredContent;
    // servers_query / servers_query_test return LiveServerState; `error` means
    // offline (e.g. gamedig "Failed all N attempts"), not a tool hard-fail.
    // MCP also sets isError when any result.error string is present — do not
    // abort Windows dual-place query retries after attempt 1.
    const softQueryOffline =
      (name === "servers_query" || name === "servers_query_test") &&
      sc &&
      typeof sc === "object" &&
      typeof sc.online === "boolean";
    if (sc && typeof sc === "object" && typeof sc.error === "string" && sc.error) {
      if (!softQueryOffline) {
        throw new Error(`${name}: ${sc.error}`);
      }
    }
    if (json?.result?.isError) {
      if (softQueryOffline) return sc;
      const text = json.result.content?.[0]?.text;
      throw new Error(`${name}: ${text || "tool_error"}`);
    }
    if (sc && typeof sc === "object") return sc;
    const text = json?.result?.content?.[0]?.text;
    if (typeof text === "string") {
      try {
        return JSON.parse(text);
      } catch {
        return { text };
      }
    }
    return sc ?? {};
  }

  /**
   * Operator node board. MCP `nodes_list` when a token is present.
   * Session cookie is the fallback when MCP cannot answer and a cookie exists.
   */
  async loadNodeBoard() {
    /** @type {unknown} */
    let mcpFailure = null;
    if (this.auth.token) {
      try {
        const board = nodeBoardFromPayload(await this.tool("nodes_list", {}));
        if (board) return board;
        mcpFailure = new Error("nodes_list returned no nodes array");
      } catch (err) {
        mcpFailure = err;
      }
      if (!this.auth.session) {
        throw new Error(asAuthOrCheck(errorMessage(mcpFailure)));
      }
    } else if (!this.auth.session) {
      throw new Error(
        "auth_failed: Windows placement needs PLAYON_MATRIX_HOME_TOKEN (MCP access token) or a live playon_session cookie",
      );
    }
    try {
      const board = nodeBoardFromPayload(await this.rest("/api/nodes"));
      if (!board) throw new Error("REST /api/nodes returned no nodes array");
      return board;
    } catch (err) {
      const msg = errorMessage(err);
      const wrapped = isAuthMessage(msg)
        ? `auth_failed: Home REST rejected the session cookie (${msg}). /api/nodes does not accept a bearer token.`
        : msg;
      const prior = mcpFailure ? errorMessage(mcpFailure) : "";
      throw new Error(prior ? `${wrapped} (MCP: ${prior})` : wrapped);
    }
  }

  async requireWinNodeOnline(nodeId) {
    const data = await this.loadNodeBoard();
    const node = (data.nodes || []).find((n) => n && n.id === nodeId);
    if (!node) {
      throw new Error(`windows_node_missing: ${nodeId} is not registered on Home`);
    }
    if (node.status !== "online" && node.status !== "stale") {
      throw new Error(`windows_node_offline: ${nodeId} status=${node.status ?? "unknown"}`);
    }
    return node;
  }

  /**
   * Live Home server rows. MCP `servers_list` when a token is present.
   * Throws if the list cannot be fetched — callers must fail closed.
   */
  async loadServerRows() {
    /** @type {unknown} */
    let mcpFailure = null;
    if (this.auth.token) {
      try {
        const rows = serverRowsFromPayload(await this.tool("servers_list", {}));
        if (rows) return rows;
        mcpFailure = new Error("servers_list returned no server array");
      } catch (err) {
        mcpFailure = err;
      }
      if (!this.auth.session) throw protectListError(mcpFailure);
    } else if (!this.auth.session) {
      throw protectListError(
        new Error("auth_failed: no MCP token and no session cookie"),
      );
    }
    try {
      const rows = serverRowsFromPayload(await this.rest("/api/servers"));
      if (!rows) throw new Error("REST /api/servers returned no server array");
      return rows;
    } catch (err) {
      const prior = mcpFailure ? errorMessage(mcpFailure) : "";
      const msg = errorMessage(err);
      throw protectListError(new Error(prior ? `${msg} (MCP: ${prior})` : msg));
    }
  }

  /**
   * Container names for live Home servers (NZL, Hub, and anything else registered).
   * Refuses to return a list when the inventory cannot be fetched.
   * @param {(serverId: string) => string} [nameFor]
   */
  async loadProtectedContainerNames(nameFor = defaultPlayonContainerName) {
    const rows = await this.loadServerRows();
    const names = new Set();
    for (const row of rows) {
      if (row && typeof row.id === "string" && row.id) names.add(nameFor(row.id));
    }
    return names;
  }
}
