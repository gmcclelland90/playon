/**
 * Fleet LAN content cache: settings helpers + managed lancachenet orchestration.
 */
import path from "node:path";
import { eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { nodes } from "../db/schema.js";
import { dispatchNodeJob } from "./node-runtime.js";
import {
  DEFAULT_LANCACHE_SETTINGS,
  getSetting,
  LANCACHE_SETTINGS_KEY,
  setSetting,
  toLancacheAgentConfig,
  toPublicLancacheSettings,
  type LancacheSettings,
} from "./settings.js";
import type { AppConfig } from "../config.js";

export {
  LANCACHE_CONTAINER,
  LANCACHE_DNS_CONTAINER,
  LANCACHE_IMAGE,
  LANCACHE_DNS_IMAGE,
} from "@playon/runtime";

export function defaultLancacheDataPath(dataRoot: string): string {
  return path.join(dataRoot, "lancache");
}

export async function loadLancacheSettings(db: Db): Promise<LancacheSettings> {
  const stored = await getSetting<LancacheSettings>(db, LANCACHE_SETTINGS_KEY);
  return { ...DEFAULT_LANCACHE_SETTINGS, ...stored };
}

export async function saveLancacheSettings(db: Db, next: LancacheSettings): Promise<void> {
  await setSetting(db, LANCACHE_SETTINGS_KEY, next);
}

export async function publicLancacheSettings(
  db: Db,
): Promise<ReturnType<typeof toPublicLancacheSettings>> {
  const settings = await loadLancacheSettings(db);
  const list = await db.select().from(nodes);
  const frees = list
    .map((n) => n.freeDiskBytes)
    .filter((n): n is number => n != null && Number.isFinite(n));
  const minFree = frees.length ? Math.min(...frees) : null;
  return toPublicLancacheSettings(settings, { minFreeDiskBytes: minFree });
}

export function agentLancacheConfig(settings: LancacheSettings) {
  return toLancacheAgentConfig(settings);
}

/** Prefer joinHost, then overlay IP, then advertise host for managed cache IP. */
export function resolveCacheIpForNode(
  node: { joinHost?: string | null; overlayIp?: string | null },
  advertiseHost?: string,
): string | undefined {
  const candidates = [node.joinHost, node.overlayIp, advertiseHost];
  for (const raw of candidates) {
    const host = raw?.trim();
    if (!host) continue;
    // strip port / brackets
    const ip = host.replace(/^\[|\]$/g, "").split(":")[0];
    if (ip && /^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) {
      const parts = ip.split(".").map(Number);
      if (parts.every((n) => n <= 255)) return ip;
    }
  }
  return undefined;
}

export async function installManagedLancache(opts: {
  db: Db;
  config: AppConfig;
  partyNodeId: string;
  manageDns?: boolean;
  dataPath?: string;
  cacheIp?: string;
}): Promise<{ settings: LancacheSettings; ensure: unknown; dns?: unknown }> {
  const rows = await opts.db.select().from(nodes).where(eq(nodes.id, opts.partyNodeId)).limit(1);
  const node = rows[0];
  if (!node) throw new Error("lancache_node_not_found");
  if (node.os !== "linux") throw new Error("lancache_linux_only");
  if (!node.docker) throw new Error("lancache_docker_required");

  const existing = await loadLancacheSettings(opts.db);
  const dataPath =
    opts.dataPath?.trim() || existing.dataPath || defaultLancacheDataPath(opts.config.dataRoot);
  const cacheIp =
    opts.cacheIp?.trim() ||
    existing.cacheIp ||
    resolveCacheIpForNode(node, opts.config.advertiseHost);
  if (!cacheIp) throw new Error("lancache_cache_ip_required");

  const manageDns = opts.manageDns ?? existing.manageDns;
  const next: LancacheSettings = {
    ...existing,
    enabled: true,
    partyNodeId: opts.partyNodeId,
    manageDns,
    dataPath,
    cacheIp,
    pinSteamcmd: true,
  };
  await saveLancacheSettings(opts.db, next);

  const ensure = await dispatchNodeJob({
    nodeId: opts.partyNodeId,
    kind: "lancache_ensure",
    args: { dataPath, cacheIp },
    timeoutMs: 600_000,
    localHandler: async () => {
      const { runLancacheEnsure } = await import("./lancache-local.js");
      return runLancacheEnsure({ dataPath, cacheIp });
    },
  });

  let dns: unknown;
  if (manageDns) {
    dns = await dispatchNodeJob({
      nodeId: opts.partyNodeId,
      kind: "lancache_dns_ensure",
      args: { cacheIp },
      timeoutMs: 300_000,
      localHandler: async () => {
        const { runLancacheDnsEnsure } = await import("./lancache-local.js");
        return runLancacheDnsEnsure({ cacheIp });
      },
    });
  }

  return { settings: next, ensure, dns };
}

export async function stopManagedLancache(opts: {
  db: Db;
  partyNodeId?: string;
}): Promise<{ settings: LancacheSettings; stop: unknown }> {
  const existing = await loadLancacheSettings(opts.db);
  const nodeId = opts.partyNodeId || existing.partyNodeId;
  if (!nodeId) throw new Error("lancache_party_node_required");

  const stop = await dispatchNodeJob({
    nodeId,
    kind: "lancache_stop",
    args: {},
    timeoutMs: 120_000,
    localHandler: async () => {
      const { runLancacheStop } = await import("./lancache-local.js");
      return runLancacheStop();
    },
  });

  const next: LancacheSettings = {
    ...existing,
    partyNodeId: null,
    manageDns: false,
  };
  await saveLancacheSettings(opts.db, next);
  return { settings: next, stop };
}

export async function statusManagedLancache(opts: {
  db: Db;
  partyNodeId?: string;
}): Promise<unknown> {
  const existing = await loadLancacheSettings(opts.db);
  const nodeId = opts.partyNodeId || existing.partyNodeId;
  if (!nodeId) {
    return { running: false, reason: "no_party_node" };
  }
  return dispatchNodeJob({
    nodeId,
    kind: "lancache_status",
    args: { dataPath: existing.dataPath },
    timeoutMs: 60_000,
    localHandler: async () => {
      const { runLancacheStatus } = await import("./lancache-local.js");
      return runLancacheStatus({ dataPath: existing.dataPath });
    },
  });
}

export async function pruneManagedLancache(opts: {
  db: Db;
  config: AppConfig;
  partyNodeId?: string;
}): Promise<unknown> {
  const existing = await loadLancacheSettings(opts.db);
  const nodeId = opts.partyNodeId || existing.partyNodeId;
  if (!nodeId) throw new Error("lancache_party_node_required");
  const dataPath = existing.dataPath || defaultLancacheDataPath(opts.config.dataRoot);
  return dispatchNodeJob({
    nodeId,
    kind: "lancache_prune",
    args: { dataPath },
    timeoutMs: 600_000,
    localHandler: async () => {
      const { runLancachePrune } = await import("./lancache-local.js");
      return runLancachePrune({ dataPath });
    },
  });
}
