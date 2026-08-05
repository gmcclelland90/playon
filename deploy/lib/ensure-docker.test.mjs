/**
 * Lightweight checks for ensure-docker.sh skip / opt-out contract (no Docker install).
 * Run: node deploy/lib/ensure-docker.test.mjs
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const script = path.join(__dirname, "ensure-docker.sh");

function run(env = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "playon-ed-"));
  const wrapper = path.join(tmp, "run.sh");
  fs.writeFileSync(
    wrapper,
    `#!/usr/bin/env bash
set -euo pipefail
source ${JSON.stringify(script)}
playon_ensure_docker
echo "RESULT=$PLAYON_ENSURE_DOCKER_RESULT"
`,
    "utf8",
  );
  const res = spawnSync("bash", [wrapper], {
    env: { ...process.env, ...env },
    encoding: "utf8",
  });
  fs.rmSync(tmp, { recursive: true, force: true });
  return res;
}

if (process.platform === "win32") {
  console.log("skip ensure-docker shell tests on Windows");
  process.exit(0);
}

if (!fs.existsSync(script)) {
  console.error("missing ensure-docker.sh");
  process.exit(1);
}

const skip = run({ PLAYON_INSTALL_DOCKER: "0" });
if (skip.status !== 0) {
  console.error("opt-out failed", skip.stderr || skip.stdout);
  process.exit(1);
}
if (!String(skip.stdout).includes("RESULT=skipped")) {
  console.error("expected RESULT=skipped", skip.stdout);
  process.exit(1);
}

console.log("ensure-docker opt-out ok");
