/** Push log lines from a remote node into the control-plane EventHub. */
export async function postNodeLogs(
  apiBase: string,
  nodeId: string,
  serverId: string,
  lines: string[],
  token?: string,
): Promise<void> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token?.trim()) headers.authorization = `Bearer ${token.trim()}`;
  const res = await fetch(
    `${apiBase.replace(/\/$/, "")}/api/nodes/${encodeURIComponent(nodeId)}/logs`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({ serverId, lines }),
    },
  );
  if (!res.ok) throw new Error(`log fan-in failed: ${res.status} ${await res.text()}`);
}

/** Push lightweight node metrics into the control plane. */
export async function postNodeMetrics(
  apiBase: string,
  nodeId: string,
  metrics: {
    freeDiskBytes?: number;
    cpuPercent?: number;
    memUsedBytes?: number;
    memTotalBytes?: number;
  },
  token?: string,
): Promise<void> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token?.trim()) headers.authorization = `Bearer ${token.trim()}`;
  const res = await fetch(
    `${apiBase.replace(/\/$/, "")}/api/nodes/${encodeURIComponent(nodeId)}/metrics`,
    {
      method: "POST",
      headers,
      body: JSON.stringify(metrics),
    },
  );
  if (!res.ok) throw new Error(`metrics fan-in failed: ${res.status} ${await res.text()}`);
}
