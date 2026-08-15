import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildHeartbeat, postHeartbeat } from "./heartbeat.js";
import { claimNextJob, executeJob, reportJobProgress, reportJobResult } from "./jobs.js";
import { relaunchUpdatedAgent } from "./self-update.js";
import { readAgentVersion } from "./version.js";
import { startWslKeepalive } from "./wsl-keepalive.js";

const apiBase = process.env.PLAYON_API_URL ?? "http://127.0.0.1:8787";
const nodeId = process.env.PLAYON_NODE_ID ?? "local";
const name = process.env.PLAYON_NODE_NAME ?? os.hostname();
const dataRoot = path.resolve(process.env.PLAYON_DATA_ROOT ?? path.join(process.cwd(), "data"));
const intervalMs = Number(process.env.PLAYON_HEARTBEAT_MS ?? 5000);
const jobPollMs = Number(process.env.PLAYON_JOB_POLL_MS ?? 1000);
const nodeToken = process.env.PLAYON_NODE_TOKEN?.trim() || undefined;
const agentVersion = readAgentVersion();

fs.mkdirSync(dataRoot, { recursive: true });

let agentStopped = false;

async function tickHeartbeat() {
  if (agentStopped) return;
  const payload = await buildHeartbeat({ nodeId, name, dataRoot, agentVersion });
  try {
    await postHeartbeat(apiBase, payload, nodeToken);
    console.log(
      `[node-agent] heartbeat ok node=${nodeId} docker=${payload.docker} native=${payload.native} steamcmd=${payload.steamcmd}`,
    );
  } catch (err) {
    console.warn(`[node-agent] heartbeat failed: ${(err as Error).message}`);
  }
}

async function tickJobs() {
  try {
    const job = await claimNextJob(apiBase, nodeId, nodeToken);
    if (!job) return;
    console.log(`[node-agent] job claim id=${job.id} kind=${job.kind}`);
    try {
      const result = await executeJob(job, dataRoot, {
        onProgress: async (message) => {
          await reportJobProgress(apiBase, nodeId, job.id, message, nodeToken);
        },
      });
      await reportJobResult(apiBase, nodeId, job.id, { ok: true, result }, nodeToken);
      console.log(`[node-agent] job done id=${job.id}`);
      if (job.kind === "node_self_update") {
        // Re-advertise jobKinds/version before the control plane sends anything else.
        await tickHeartbeat();
      }
      if (
        result &&
        typeof result === "object" &&
        (result as { restartRequired?: boolean }).restartRequired === true
      ) {
        console.log(`[node-agent] restarting after self-update`);
        stopAgentLoops();
        const installRoot =
          typeof (result as { installRoot?: unknown }).installRoot === "string"
            ? (result as { installRoot: string }).installRoot
            : process.env.PLAYON_INSTALL_ROOT || process.cwd();
        relaunchUpdatedAgent({ installRoot });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "job_failed";
      await reportJobResult(apiBase, nodeId, job.id, { ok: false, error: message }, nodeToken);
      console.warn(`[node-agent] job failed id=${job.id}: ${message}`);
    }
  } catch (err) {
    console.warn(`[node-agent] job poll failed: ${(err as Error).message}`);
  }
}

/** Serialize jobs so long seeds don't overlap; heartbeats keep firing while a job awaits I/O. */
let jobBusy = false;
const agentTimers: ReturnType<typeof setInterval>[] = [];

function stopAgentLoops(): void {
  agentStopped = true;
  for (const timer of agentTimers.splice(0)) clearInterval(timer);
}

async function tickJobsGuarded() {
  if (agentStopped || jobBusy) return;
  jobBusy = true;
  try {
    await tickJobs();
  } finally {
    jobBusy = false;
  }
}

console.log(`PlayOn node-agent starting → ${apiBase}`);
await tickHeartbeat();
agentTimers.push(
  setInterval(() => {
    if (!agentStopped) void tickHeartbeat();
  }, intervalMs),
);
agentTimers.push(
  setInterval(() => {
    void tickJobsGuarded();
  }, jobPollMs),
);
// Immediate job poll so int tests don't wait a full interval.
void tickJobsGuarded();
// Windows parent agent: keep playon-linux awake so the sibling keeps heartbeating.
startWslKeepalive({ nodeId });
