/**
 * Real-Docker smoke for games.minecraft-paper.
 * Requires PLAYON_RUNTIME=docker and a working Docker engine.
 *
 *   node scripts/paper-docker-smoke.mjs
 */
import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDb } from "../apps/api/dist/db/client.js";
import { applyBootstrap } from "../apps/api/dist/db/migrate.js";
import { ServerService } from "../apps/api/dist/services/servers.js";
import { createRuntimeAdapters } from "../packages/runtime/dist/factory.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(repoRoot);

const root = fs.mkdtempSync(path.join(os.tmpdir(), "playon-paper-"));
const dbPath = path.join(root, "playon.db");
applyBootstrap(dbPath);
const { db, sqlite } = createDb(dbPath);

const config = {
  port: 0,
  dataRoot: root,
  dbPath,
  sessionSecret: "paper-smoke-secret",
  llmMode: "openai_compatible",
  runtimeMode: "docker",
  skillsRoots: [
    path.join(repoRoot, "skills", "games"),
    path.join(root, "skills"),
  ],
};

const adapters = await createRuntimeAdapters("docker");
console.log("runtime_mode=", adapters.mode);
if (adapters.mode !== "docker") {
  console.error("expected docker runtime, got", adapters.mode);
  process.exit(2);
}

const servers = new ServerService(db, config);
const created = await servers.createFromSkill({
  skillName: "games.minecraft-paper",
  serverName: "Paper Smoke",
});
console.log("created=", created.id, created.runtimeMode, created.status);

const started = await servers.start(created.id);
console.log("started=", started.status);

const name = `playon-${created.id}`;
const inspect = execSync(`docker inspect -f '{{.State.Status}}|{{.Config.Image}}' ${name}`, {
  encoding: "utf8",
}).trim();
console.log("docker_inspect=", inspect);
if (!inspect.includes("itzg/minecraft-server")) {
  console.error("unexpected image");
  process.exit(3);
}

const stopped = await servers.stop(created.id);
console.log("stopped=", stopped.status);

try {
  execSync(`docker rm -f ${name}`, { stdio: "ignore" });
} catch {
  /* ignore */
}

sqlite.close();
console.log("paper_docker_smoke=ok");
