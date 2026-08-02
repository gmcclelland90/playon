import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildHeartbeat, postHeartbeat } from "./heartbeat.js";
import { claimNextJob, executeJob, reportJobResult } from "./jobs.js";

const apiBase = process.env.PLAYON_API_URL ?? "http://127.0.0.1:8787";
const nodeId = process.env.PLAYON_NODE_ID ?? "local";
const name = process.env.PLAYON_NODE_NAME ?? os.hostname();
const dataRoot = path.resolve(process.env.PLAYON_DATA_ROOT ?? path.join(process.cwd(), "data"));
const intervalMs = Number(process.env.PLAYON_HEARTBEAT_MS ?? 5000);
const jobPollMs = Number(process.env.PLAYON_JOB_POLL_MS ?? 1000);
const nodeToken = process.env.PLAYON_NODE_TOKEN?.trim() || undefined;

fs.mkdirSync(dataRoot, { recursive: true });

async function tickHeartbeat() {
  const payload = buildHeartbeat({ nodeId, name, dataRoot });
  try {
    await postHeartbeat(apiBase, payload, nodeToken);
    console.log(`[node-agent] heartbeat ok node=${nodeId} docker=${payload.docker}`);
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
      const result = executeJob(job, dataRoot);
      await reportJobResult(apiBase, nodeId, job.id, { ok: true, result }, nodeToken);
      console.log(`[node-agent] job done id=${job.id}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : "job_failed";
      await reportJobResult(apiBase, nodeId, job.id, { ok: false, error: message }, nodeToken);
      console.warn(`[node-agent] job failed id=${job.id}: ${message}`);
    }
  } catch (err) {
    console.warn(`[node-agent] job poll failed: ${(err as Error).message}`);
  }
}

console.log(`PlayOn node-agent starting → ${apiBase}`);
await tickHeartbeat();
setInterval(() => {
  void tickHeartbeat();
}, intervalMs);
setInterval(() => {
  void tickJobs();
}, jobPollMs);
// Immediate job poll so int tests don't wait a full interval.
void tickJobs();
