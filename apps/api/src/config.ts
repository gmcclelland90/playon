import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface AppConfig {
  port: number;
  dataRoot: string;
  dbPath: string;
  sessionSecret: string;
  llmMode: "mock" | "openai_compatible" | "ollama";
  runtimeMode: "mock" | "docker" | "native";
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


function findRepoRoot(start: string): string {
  let dir = path.resolve(start);
  while (true) {
    if (fs.existsSync(path.join(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return start;
    dir = parent;
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const dataRoot = path.resolve(env.PLAYON_DATA_ROOT ?? path.join(process.cwd(), "data"));
  fs.mkdirSync(dataRoot, { recursive: true });
  fs.mkdirSync(path.join(dataRoot, "servers"), { recursive: true });
  fs.mkdirSync(path.join(dataRoot, "skills"), { recursive: true });
  fs.mkdirSync(path.join(dataRoot, "skills", "_drafts"), { recursive: true });
  fs.mkdirSync(path.join(dataRoot, "snapshots"), { recursive: true });

  const repoRoot = findRepoRoot(process.cwd());

  return {
    port: Number(env.PLAYON_PORT ?? 8787),
    dataRoot,
    dbPath: path.resolve(env.PLAYON_DB_PATH ?? path.join(dataRoot, "playon.db")),
    sessionSecret: env.PLAYON_SESSION_SECRET ?? `dev-${os.hostname()}-playon`,
    llmMode: (env.PLAYON_LLM_MODE as AppConfig["llmMode"]) ?? "mock",
    runtimeMode: (env.PLAYON_RUNTIME as AppConfig["runtimeMode"]) ?? "mock",
    skillsRoots: [
      path.join(repoRoot, "skills", "fixtures"),
      path.join(repoRoot, "skills", "games"),
      path.join(repoRoot, "skills", "platform"),
      path.join(dataRoot, "skills"),
    ],
    advertiseHost: detectAdvertiseHost(env),
    nodeToken: env.PLAYON_NODE_TOKEN?.trim() || undefined,
    backupRoot: env.PLAYON_BACKUP_ROOT?.trim() || undefined,
  };
}

