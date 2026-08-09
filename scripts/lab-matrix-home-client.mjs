#!/usr/bin/env node
/**
 * Live Home client for lab-matrix Windows placement.
 * Windows node agents heartbeat/job-poll durable Home — not the matrix temp CP.
 */
import fs from "node:fs";
import path from "node:path";
import { createDb } from "../apps/api/dist/db/client.js";
import { createSession } from "../apps/api/dist/auth/session.js";
import { createAccessToken } from "../apps/api/dist/services/access-tokens.js";

const DEFAULT_API = "http://127.0.0.1:8787";
const DEFAULT_WIN_NODE = "playon-win-1";
const DEFAULT_WIN_HOST = "172.16.0.94";
const DURABLE_DB = "/home/playon/src/playon/apps/api/data/playon.db";

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

async function mintAuth(cfg) {
  if (!fs.existsSync(cfg.durableDb)) {
    throw new Error(`durable Home db missing: ${cfg.durableDb}`);
  }
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
    const auth = {
      token: tok.token,
      session,
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

export async function loadHomeAuth(cfg) {
  if (process.env.PLAYON_MATRIX_HOME_TOKEN?.trim()) {
    return {
      token: process.env.PLAYON_MATRIX_HOME_TOKEN.trim(),
      session: process.env.PLAYON_MATRIX_HOME_SESSION?.trim() || "",
      api: cfg.api,
      winNodeId: cfg.winNodeId,
      winHost: cfg.winHost,
    };
  }
  if (fs.existsSync(cfg.authPath)) {
    const auth = JSON.parse(fs.readFileSync(cfg.authPath, "utf8"));
    if (auth.token && auth.session) {
      return { ...auth, api: auth.api || cfg.api, winNodeId: cfg.winNodeId, winHost: cfg.winHost };
    }
  }
  return mintAuth(cfg);
}

export class HomeClient {
  constructor(auth) {
    this.auth = auth;
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
    const res = await fetch(`${this.auth.api}${pathname}`, {
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
      const detail = json?.error?.message || json?.message || text.slice(0, 300);
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
    const res = await fetch(`${this.auth.api}/mcp`, {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
    });
    const sid = res.headers.get("mcp-session-id");
    if (sid) this.mcpSession = sid;
    const text = await res.text();
    if (!text) return null;
    const json = parseSseJson(text);
    if (json?.error) {
      throw new Error(`mcp_${method}: ${JSON.stringify(json.error)}`);
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

  async requireWinNodeOnline(nodeId) {
    const data = await this.rest("/api/nodes");
    const node = (data.nodes || []).find((n) => n.id === nodeId);
    if (!node) throw new Error(`windows_node_missing: ${nodeId}`);
    if (node.status !== "online" && node.status !== "stale") {
      throw new Error(`windows_node_offline: ${nodeId} status=${node.status}`);
    }
    return node;
  }
}
