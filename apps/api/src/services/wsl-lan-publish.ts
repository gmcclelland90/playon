import {
  evaluateWslLanPublish,
  isWslNodeId,
  wslParentNodeId,
} from "@playon/shared";
import { nodeJobService } from "./node-jobs.js";

const PUBLISH_TIMEOUT_MS = 12_000;

export type WslLanPublishPort = { port: number; protocol: "tcp" | "udp" };

export function parentAdvertisesLanPublish(parentNodeId: string): boolean {
  const kinds = nodeJobService.advertisedJobKinds(parentNodeId);
  return Boolean(kinds?.includes("net_port_publish"));
}

async function runPublishJob(
  parentNodeId: string,
  args: Record<string, unknown>,
): Promise<{ ok: boolean; listening: boolean; error?: string }> {
  try {
    const job = nodeJobService.enqueue(parentNodeId, "net_port_publish", args);
    const done = await nodeJobService.waitFor(job.id, { timeoutMs: PUBLISH_TIMEOUT_MS });
    if (done.status === "failed" || !done.result || typeof done.result !== "object") {
      return { ok: false, listening: false, error: done.error ?? "net_port_publish_failed" };
    }
    const result = done.result as { ok?: boolean; listening?: boolean; error?: string };
    return {
      ok: result.ok === true,
      listening: result.listening === true,
      error: result.error,
    };
  } catch (err) {
    return {
      ok: false,
      listening: false,
      error: err instanceof Error ? err.message : "net_port_publish_unavailable",
    };
  }
}

/**
 * After a WSL sibling start: publish skill ports on the Windows parent LAN IP
 * (join_host) → 127.0.0.1 (WSL localhostForwarding). Not netsh; not Home soak.
 */
export async function ensureWslLanPublish(opts: {
  serverId: string;
  wslNodeId: string | null | undefined;
  parentJoinHost: string;
  ports: WslLanPublishPort[];
}): Promise<{ published: number; failed: number; reason: string }> {
  if (!opts.wslNodeId || !isWslNodeId(opts.wslNodeId)) {
    return { published: 0, failed: 0, reason: "not_wsl" };
  }
  const parentId = wslParentNodeId(opts.wslNodeId);
  if (!parentId) return { published: 0, failed: 0, reason: "no_wsl_parent" };
  const verdict = evaluateWslLanPublish({
    parentJoinHost: opts.parentJoinHost,
    parentAdvertisesPublish: parentAdvertisesLanPublish(parentId),
  });
  if (!verdict.ok) return { published: 0, failed: 0, reason: verdict.reason };

  let published = 0;
  let failed = 0;
  for (const p of opts.ports) {
    const result = await runPublishJob(parentId, {
      action: "ensure",
      serverId: opts.serverId,
      listenHost: verdict.joinHost,
      listenPort: p.port,
      protocol: p.protocol,
      targetHost: "127.0.0.1",
      targetPort: p.port,
    });
    if (result.listening) published += 1;
    else failed += 1;
  }
  return {
    published,
    failed,
    reason: published > 0 ? "wsl_lan_published" : "wsl_lan_publish_failed",
  };
}

export async function releaseWslLanPublish(opts: {
  serverId: string;
  wslNodeId: string | null | undefined;
}): Promise<void> {
  if (!opts.wslNodeId || !isWslNodeId(opts.wslNodeId)) return;
  const parentId = wslParentNodeId(opts.wslNodeId);
  if (!parentId) return;
  if (!parentAdvertisesLanPublish(parentId)) return;
  await runPublishJob(parentId, { action: "release_server", serverId: opts.serverId });
}
