import { eq } from "drizzle-orm";
import {
  appendUsageHistory,
  hostResourceAlerts,
  parseUsageHistory,
  serverResourceAlerts,
  type HostUsageSample,
  type ResourceAlert,
  type ServerUsageSample,
  type UsageHistory,
} from "@playon/shared";
import type { Db } from "../db/client.js";
import { nodes, servers } from "../db/schema.js";
import { serverUsageFromInventory } from "./node-inventory.js";

export function serializeUsageHistory(history: UsageHistory): string {
  return JSON.stringify(history);
}

export async function persistNodeUsageSample(
  db: Db,
  nodeId: string,
  host: Omit<HostUsageSample, "t"> & { t?: number },
  at = Date.now(),
): Promise<UsageHistory> {
  const row = await db.select().from(nodes).where(eq(nodes.id, nodeId)).limit(1);
  const prev = parseUsageHistory(row[0]?.usageHistoryJson);
  const nodeServers = await db.select().from(servers).where(eq(servers.nodeId, nodeId));
  const serverSamples: Record<string, ServerUsageSample> = {};
  for (const s of nodeServers) {
    const usage = serverUsageFromInventory(s.id, nodeId, s.runtimeMode);
    if (usage.cpuPercent != null || usage.memUsedBytes != null) {
      serverSamples[s.id] = { t: at, ...usage };
    }
  }
  const next = appendUsageHistory(prev, { ...host, t: host.t ?? at }, serverSamples, at);
  await db
    .update(nodes)
    .set({ usageHistoryJson: serializeUsageHistory(next) })
    .where(eq(nodes.id, nodeId));
  return next;
}

export function alertsForNode(opts: {
  nodeId: string;
  nodeName: string;
  current: {
    cpuPercent?: number | null;
    memUsedBytes?: number | null;
    memTotalBytes?: number | null;
    freeDiskBytes?: number | null;
  };
  history: UsageHistory;
  hostedServers?: Array<{
    id: string;
    name: string;
    cpuPercent?: number | null;
    memUsedBytes?: number | null;
  }>;
}): ResourceAlert[] {
  const alerts = hostResourceAlerts({
    nodeId: opts.nodeId,
    nodeName: opts.nodeName,
    current: opts.current,
    history: opts.history.host,
  });
  for (const s of opts.hostedServers ?? []) {
    alerts.push(
      ...serverResourceAlerts({
        nodeId: opts.nodeId,
        nodeName: opts.nodeName,
        serverId: s.id,
        serverName: s.name,
        current: s,
      }),
    );
  }
  return alerts;
}
