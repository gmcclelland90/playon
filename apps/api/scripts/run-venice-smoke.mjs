import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const cwd = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const result = spawnSync("pnpm", ["exec", "tsx", "src/venice-smoke.ts"], {
  cwd,
  encoding: "utf8",
  shell: true,
  env: process.env,
});

const out = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
process.stdout.write(result.stdout ?? "");
process.stderr.write(result.stderr ?? "");

if (out.includes("venice_smoke=ok")) {
  process.exit(0);
}
process.exit(result.status && result.status !== 0 ? result.status : 1);
