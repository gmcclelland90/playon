import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildHeartbeat, postHeartbeat } from "./heartbeat.js";

const apiBase = process.env.PLAYON_API_URL ?? "http://127.0.0.1:8787";
const nodeId = process.env.PLAYON_NODE_ID ?? "local";
const name = process.env.PLAYON_NODE_NAME ?? os.hostname();
const dataRoot = path.resolve(process.env.PLAYON_DATA_ROOT ?? path.join(process.cwd(), "data"));
const intervalMs = Number(process.env.PLAYON_HEARTBEAT_MS ?? 5000);
const nodeToken = process.env.PLAYON_NODE_TOKEN?.trim() || undefined;

fs.mkdirSync(dataRoot, { recursive: true });

async function tick() {
  const payload = buildHeartbeat({ nodeId, name, dataRoot });
  try {
    await postHeartbeat(apiBase, payload, nodeToken);
    console.log(`[node-agent] heartbeat ok node=${nodeId} docker=${payload.docker}`);
  } catch (err) {
    console.warn(`[node-agent] heartbeat failed: ${(err as Error).message}`);
  }
}

console.log(`PlayOn node-agent starting → ${apiBase}`);
await tick();
setInterval(() => {
  void tick();
}, intervalMs);
