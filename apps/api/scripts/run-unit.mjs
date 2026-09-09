/**
 * @playon/api unit runner.
 *
 * Linux: one `vitest run` (same as before).
 *
 * Windows CI: sequential vitest processes so a singleFork worker cannot sit on
 * the two historically fatal files (~124s envelope + ~177s runtime-handle)
 * and then miss birpc onTaskUpdate after every assertion already passed
 * (run 34306522471; same class as #912 / vitest#6511).
 */
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const apiRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const vitestPkg = path.dirname(require.resolve("vitest/package.json"));
const vitestCli = path.join(vitestPkg, "vitest.mjs");

function run(args) {
  const result = spawnSync(process.execPath, [vitestCli, "run", ...args], {
    cwd: apiRoot,
    stdio: "inherit",
    env: process.env,
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

if (process.platform !== "win32") {
  run([]);
  process.exit(0);
}

run(["src/http-envelope-routes-auth.test.ts", "src/http-envelope-routes-skills.test.ts"]);
run(["src/http-envelope-routes-nodes.test.ts", "src/http-envelope-routes-settings.test.ts"]);
run(["src/services/servers-runtime-handle-local-docker.test.ts"]);
run(["src/services/servers-runtime-handle-local-native.test.ts"]);
run([
  "src/services/servers-runtime-handle-remote-docker.test.ts",
  "src/services/servers-runtime-handle-remote-native.test.ts",
]);
run([
  "src/services/servers-runtime-handle-logs.test.ts",
  "src/services/servers-runtime-handle-console.test.ts",
]);
run(["src/services/node-inventory.test.ts"]);
run(["src/services/snapshots-node-sync.test.ts", "src/services/snapshots.test.ts"]);
run([
  "--exclude",
  "src/**/*.int.test.ts",
  "--exclude",
  "src/http-envelope-routes-*.test.ts",
  "--exclude",
  "src/services/servers-runtime-handle-*.test.ts",
  "--exclude",
  "src/services/node-inventory.test.ts",
  "--exclude",
  "src/services/snapshots-node-sync.test.ts",
  "--exclude",
  "src/services/snapshots.test.ts",
]);
