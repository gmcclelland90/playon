import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveCatalogGamesRoot } from "./lab-games-root.js";

export interface AppConfig {
  port: number;
  /** Bind address for the HTTP server (set by loadConfig; tests may omit). */
  host?: string;
  /**
   * Preferred LAN HTTP port (80 in production when binding 0.0.0.0).
   * Falls back to `port` when bind fails (EACCES / in use).
   */
  preferredLanPort?: number;
  /** Loopback HTTP port for local node-agent (defaults to `port`). */
  loopbackPort?: number;
  dataRoot: string;
  dbPath: string;
  sessionSecret: string;
  /** Default LLM provider when Settings has no override. */
  llmMode: "openai_compatible" | "ollama";
  runtimeMode: "docker" | "native";
  skillsRoots: string[];
  /** Address shown to players for joining (LAN IP / hostname). */
  advertiseHost: string;
  /**
   * Shared bearer token for node-agent heartbeats.
   * Empty = open (local/dev only). Set PLAYON_NODE_TOKEN in real LAN deploys.
   */
  nodeToken?: string;
  /** Optional default off-node backup root (USB/NAS/second disk). */
  backupRoot?: string;
  /** Absolute path to Vite `apps/web/dist` (SPA + assets). */
  webDist?: string;
  /** CORS allowlist (set by loadConfig; tests may omit). */
  corsOrigins?: string[];
  /** True when PLAYON_ENV or NODE_ENV is production. */
  isProduction?: boolean;
  /** playon.games origin for Discord hostname DNS/ACME helper. */
  homeDnsApiUrl?: string;
  /** When true, try mDNS playon.local (default on in production LAN bind). */
  mdnsEnabled?: boolean;
}

export function isProductionEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.PLAYON_ENV === "production" || env.NODE_ENV === "production";
}

function detectAdvertiseHost(env: NodeJS.ProcessEnv): string {
  if (env.PLAYON_ADVERTISE_HOST?.trim()) return env.PLAYON_ADVERTISE_HOST.trim();
  const nets = os.networkInterfaces();
  for (const entries of Object.values(nets)) {
    for (const entry of entries ?? []) {
      if (entry.family === "IPv4" && !entry.internal) return entry.address;
    }
  }
  return "127.0.0.1";
}

export function findRepoRoot(start: string): string {
  let dir = path.resolve(start);
  while (true) {
    if (fs.existsSync(path.join(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return start;
    dir = parent;
  }
}

/** Split PLAYON_SKILLS_ROOT without breaking Windows drive letters (C:\...). */
export function splitSkillsRootPaths(raw: string): string[] {
  const sep = process.platform === "win32" ? /;/g : /[:;]/g;
  return raw.split(sep).map((s) => s.trim()).filter(Boolean);
}

function parseLlmMode(raw: string | undefined): AppConfig["llmMode"] {
  if (raw === "ollama") return "ollama";
  return "openai_compatible";
}

function parseRuntimeMode(raw: string | undefined): AppConfig["runtimeMode"] {
  if (raw === "native") return "native";
  return "docker";
}

function parseCorsExtra(raw: string | undefined): string[] {
  if (!raw?.trim()) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Build browser CORS allowlist for Vite dev + LAN advertise + playon.local + extras. */
export function buildCorsOrigins(opts: {
  advertiseHost: string;
  port: number;
  preferredLanPort?: number;
  publicHostname?: string;
  extra?: string[];
}): string[] {
  const origins = new Set<string>([
    "http://localhost:5173",
    "http://127.0.0.1:5173",
    `http://localhost:${opts.port}`,
    `http://127.0.0.1:${opts.port}`,
    "http://playon.local",
    "http://playon.local:80",
    `http://playon.local:${opts.port}`,
  ]);
  const lanPort = opts.preferredLanPort ?? opts.port;
  if (lanPort !== opts.port) {
    origins.add(`http://playon.local:${lanPort}`);
    origins.add(`http://localhost:${lanPort}`);
    origins.add(`http://127.0.0.1:${lanPort}`);
  }
  const host = opts.advertiseHost.trim();
  if (host) {
    const bare = host.replace(/^https?:\/\//i, "").replace(/\/.*$/, "");
    origins.add(`http://${bare}`);
    origins.add(`https://${bare}`);
    if (!bare.includes(":")) {
      origins.add(`http://${bare}:${opts.port}`);
      origins.add(`https://${bare}:${opts.port}`);
      if (lanPort !== opts.port) {
        origins.add(`http://${bare}:${lanPort}`);
        origins.add(`https://${bare}:${lanPort}`);
      }
    }
  }
  const pub = opts.publicHostname?.trim();
  if (pub) {
    const bare = pub.replace(/^https?:\/\//i, "").replace(/\/.*$/, "");
    origins.add(`https://${bare}`);
    origins.add(`http://${bare}`);
  }
  for (const o of opts.extra ?? []) origins.add(o);
  return [...origins];
}

export function resolveWebDist(env: NodeJS.ProcessEnv, repoRoot: string): string {
  if (env.PLAYON_WEB_DIST?.trim()) return path.resolve(env.PLAYON_WEB_DIST.trim());
  return path.join(repoRoot, "apps", "web", "dist");
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const production = isProductionEnv(env);

  if (production) {
    if (!env.PLAYON_SESSION_SECRET?.trim()) {
      throw new Error(
        "PLAYON_SESSION_SECRET required in production (set PLAYON_ENV=production / NODE_ENV=production)",
      );
    }
    if (!env.PLAYON_ADVERTISE_HOST?.trim()) {
      throw new Error(
        "PLAYON_ADVERTISE_HOST required in production (LAN IP or hostname shown to players)",
      );
    }
  }

  const dataRoot = path.resolve(env.PLAYON_DATA_ROOT ?? path.join(process.cwd(), "data"));
  fs.mkdirSync(dataRoot, { recursive: true });
  fs.mkdirSync(path.join(dataRoot, "servers"), { recursive: true });
  fs.mkdirSync(path.join(dataRoot, "skills"), { recursive: true });
  fs.mkdirSync(path.join(dataRoot, "skills", "_drafts"), { recursive: true });
  fs.mkdirSync(path.join(dataRoot, "snapshots"), { recursive: true });

  const repoRoot = findRepoRoot(process.cwd());
  const port = Number(env.PLAYON_PORT ?? 8787);
  const host = env.PLAYON_HOST?.trim() || "127.0.0.1";
  const loopbackPort = Number(env.PLAYON_LOOPBACK_PORT ?? port);
  const preferPrivileged =
    env.PLAYON_LAN_PORT?.trim() ||
    (production && (host === "0.0.0.0" || host === "::") ? "80" : String(port));
  const preferredLanPort = Number(preferPrivileged);
  const advertiseHost = production
    ? env.PLAYON_ADVERTISE_HOST!.trim()
    : detectAdvertiseHost(env);
  const homeDnsApiUrl = (env.PLAYON_HOME_DNS_API_URL?.trim() || "https://playon.games").replace(
    /\/$/,
    "",
  );
  const mdnsEnabled =
    env.PLAYON_MDNS === "0" || env.PLAYON_MDNS === "false"
      ? false
      : env.PLAYON_MDNS === "1" || env.PLAYON_MDNS === "true"
        ? true
        : production && (host === "0.0.0.0" || host === "::");
  const extraCors = parseCorsExtra(env.PLAYON_CORS_ORIGINS);
  /**
   * `minimal` = platform skills only (Home / production shape).
   * `dev` (default) also mounts repo test fixtures under skills/fixtures.
   * Curated games.* skills are never bundled — install from the playon.games catalog
   * into dataRoot/skills.
   */
  const skillsProfile = (env.PLAYON_SKILLS_PROFILE?.trim() || "dev").toLowerCase();
  /**
   * Optional baked/install skills root (Home tarball / container).
   * Semicolon-separated absolute paths (also `:` on non-Windows). Each may contain
   * platform|fixtures subdirs or be a single skill category directory.
   */
  const bakedSkillsRoot = env.PLAYON_SKILLS_ROOT?.trim();
  const skillsRoots: string[] = [];
  if (bakedSkillsRoot) {
    const parts = splitSkillsRootPaths(bakedSkillsRoot);
    for (const part of parts) {
      const abs = path.resolve(part);
      const platform = path.join(abs, "platform");
      const fixtures = path.join(abs, "fixtures");
      if (fs.existsSync(platform) || fs.existsSync(fixtures)) {
        if (fs.existsSync(platform)) skillsRoots.push(platform);
        if (skillsProfile !== "minimal" && fs.existsSync(fixtures)) skillsRoots.push(fixtures);
      } else {
        skillsRoots.push(abs);
      }
    }
  } else {
    skillsRoots.push(path.join(repoRoot, "skills", "platform"));
    if (skillsProfile !== "minimal") {
      skillsRoots.push(path.join(repoRoot, "skills", "fixtures"));
    }
  }
  skillsRoots.push(path.join(dataRoot, "skills"));

  // Lab / sibling playon-games checkout (never shipped in Home tarballs).
  const catalogGames = resolveCatalogGamesRoot(repoRoot);
  if (catalogGames && skillsProfile !== "minimal") {
    skillsRoots.push(catalogGames);
  }

  return {
    port,
    host,
    preferredLanPort: Number.isFinite(preferredLanPort) ? preferredLanPort : port,
    loopbackPort: Number.isFinite(loopbackPort) ? loopbackPort : port,
    dataRoot,
    dbPath: path.resolve(env.PLAYON_DB_PATH ?? path.join(dataRoot, "playon.db")),
    sessionSecret: env.PLAYON_SESSION_SECRET?.trim() || `dev-${os.hostname()}-playon`,
    llmMode: parseLlmMode(env.PLAYON_LLM_MODE),
    runtimeMode: parseRuntimeMode(env.PLAYON_RUNTIME),
    skillsRoots,
    advertiseHost,
    nodeToken: env.PLAYON_NODE_TOKEN?.trim() || undefined,
    backupRoot: env.PLAYON_BACKUP_ROOT?.trim() || undefined,
    webDist: resolveWebDist(env, repoRoot),
    corsOrigins: buildCorsOrigins({
      advertiseHost,
      port,
      preferredLanPort: Number.isFinite(preferredLanPort) ? preferredLanPort : port,
      extra: extraCors,
    }),
    isProduction: production,
    homeDnsApiUrl,
    mdnsEnabled,
  };
}
