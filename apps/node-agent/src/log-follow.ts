import { followLogFile, type DockerAdapter } from "@playon/runtime";
import { postNodeLogs } from "./fanin.js";

type FollowEntry = {
  abort: () => void;
  flushTimer?: ReturnType<typeof setInterval>;
  pending: string[];
};

const follows = new Map<string, FollowEntry>();

function apiContext(): { apiBase: string; nodeId: string; token?: string } {
  return {
    apiBase: process.env.PLAYON_API_URL ?? "http://127.0.0.1:8787",
    nodeId: process.env.PLAYON_NODE_ID ?? "local",
    token: process.env.PLAYON_NODE_TOKEN?.trim() || undefined,
  };
}

async function flush(serverId: string, entry: FollowEntry): Promise<void> {
  if (entry.pending.length === 0) return;
  const batch = entry.pending.splice(0, 200);
  const { apiBase, nodeId, token } = apiContext();
  try {
    await postNodeLogs(apiBase, nodeId, serverId, batch, token);
  } catch (err) {
    entry.pending.unshift(...batch);
    if (entry.pending.length > 1000) {
      entry.pending.splice(0, entry.pending.length - 1000);
    }
    console.warn(
      `[node-agent] log fan-in failed server=${serverId}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

function ensureEntry(serverId: string): FollowEntry {
  stopLogFollow(serverId);
  const entry: FollowEntry = {
    abort: () => undefined,
    pending: [],
  };
  entry.flushTimer = setInterval(() => {
    void flush(serverId, entry);
  }, 750);
  follows.set(serverId, entry);
  return entry;
}

export function stopLogFollow(serverId: string): void {
  const entry = follows.get(serverId);
  if (!entry) return;
  entry.abort();
  if (entry.flushTimer) clearInterval(entry.flushTimer);
  follows.delete(serverId);
}

/** Tail a growing native console.log and fan-in lines. */
export function beginFileLogFollow(serverId: string, logPath: string): void {
  const entry = ensureEntry(serverId);
  const handle = followLogFile(logPath, (line) => {
    entry.pending.push(line);
  });
  entry.abort = handle.abort;
}

/** Follow Docker container logs and fan-in lines. */
export async function beginContainerLogFollow(
  serverId: string,
  docker: DockerAdapter,
  containerId: string,
): Promise<void> {
  if (typeof docker.followLogs !== "function") return;
  const entry = ensureEntry(serverId);
  const handle = await docker.followLogs(containerId, (line) => {
    entry.pending.push(line);
  });
  entry.abort = handle.abort;
}
