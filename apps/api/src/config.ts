import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface AppConfig {
  port: number;
  /** Bind address for the HTTP server (set by loadConfig; tests may omit). */
  host?: string;
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

/** Build browser CORS allowlist for Vite dev + LAN advertise + extras. */
export function buildCorsOrigins(opts: {
  advertiseHost: string;
  port: number;
  extra?: string[];
}): string[] {
  const origins = new Set<string>([
    "http://localhost:5173",
    "http://127.0.0.1:5173",
    `http://localhost:${opts.port}`,
    `http://127.0.0.1:${opts.port}`,
  ]);
  const host = opts.advertiseHost.trim();
  if (host) {
    const bare = host.replace(/^https?:\/\//i, "").replace(/\/.*$/, "");
    origins.add(`http://${bare}`);
    origins.add(`https://${bare}`);
    if (!bare.includes(":")) {
      origins.add(`http://${bare}:${opts.port}`);
      origins.add(`https://${bare}:${opts.port}`);
    }
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
  const advertiseHost = production
    ? env.PLAYON_ADVERTISE_HOST!.trim()
    : detectAdvertiseHost(env);
  const extraCors = parseCorsExtra(env.PLAYON_CORS_ORIGINS);
  /** `minimal` = platform skills only (library-shaped). `dev` (default) also mounts repo games. */
  const skillsProfile = (env.PLAYON_SKILLS_PROFILE?.trim() || "dev").toLowerCase();
  const skillsRoots = [
    path.join(repoRoot, "skills", "platform"),
    path.join(dataRoot, "skills"),
  ];
  if (skillsProfile !== "minimal") {
    skillsRoots.unshift(path.join(repoRoot, "skills", "games"));
    skillsRoots.push(path.join(repoRoot, "skills", "fixtures"));
  }

  return {
    port,
    host: env.PLAYON_HOST?.trim() || "127.0.0.1",
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
    corsOrigins: buildCorsOrigins({ advertiseHost, port, extra: extraCors }),
    isProduction: production,
  };
}
