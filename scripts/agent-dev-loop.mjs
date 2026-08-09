#!/usr/bin/env node
/**
 * Autonomous develop/test loop runner.
 *
 * Runs the layered merge bar, writes a machine-readable status file the next
 * agent turn can read, and exits non-zero on the first failed layer.
 *
 * Usage:
 *   node scripts/agent-dev-loop.mjs              # merge bar (check→agent)
 *   node scripts/agent-dev-loop.mjs --fast       # check + unit + contract only
 *   node scripts/agent-dev-loop.mjs --runtime    # merge bar + Paper Docker smoke
 *   node scripts/agent-dev-loop.mjs --layer int  # single layer
 *
 * Status artifact: tmp/agent-loop-status.json
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = process.cwd();
const scriptsDir = dirname(fileURLToPath(import.meta.url));
const statusPath = join(root, "tmp", "agent-loop-status.json");
const args = new Set(process.argv.slice(2));

const LAYERS = {
  check: { cmd: "pnpm", argv: ["check"], needs: "node" },
  unit: { cmd: "pnpm", argv: ["test:unit"], needs: "node" },
  contract: { cmd: "pnpm", argv: ["test:contract"], needs: "node" },
  int: { cmd: "pnpm", argv: ["test:int"], needs: "node" },
  agent: { cmd: "pnpm", argv: ["test:agent"], needs: "node" },
  runtime: {
    cmd: "pnpm",
    argv: ["smoke:paper-docker"],
    needs: "docker",
  },
};

function selectedLayers() {
  const layerFlag = process.argv.indexOf("--layer");
  if (layerFlag !== -1) {
    const name = process.argv[layerFlag + 1];
    if (!name || !LAYERS[name]) {
      console.error(`unknown layer: ${name ?? "(missing)"}`);
      console.error(`known: ${Object.keys(LAYERS).join(", ")}`);
      process.exit(2);
    }
    return [name];
  }
  if (args.has("--fast")) return ["check", "unit", "contract"];
  if (args.has("--runtime")) {
    return ["check", "unit", "contract", "int", "agent", "runtime"];
  }
  // Default merge bar from the plan
  return ["check", "unit", "contract", "int", "agent"];
}

function runLayer(name) {
  const layer = LAYERS[name];
  const started = Date.now();
  console.log(`\n==> layer:${name} (${layer.argv.join(" ")})`);
  const result = spawnSync(layer.cmd, layer.argv, {
    cwd: root,
    encoding: "utf8",
    shell: process.platform === "win32",
    env: {
      ...process.env,
      PLAYON_LLM_MODE: process.env.PLAYON_LLM_MODE ?? "openai_compatible",
      PLAYON_RUNTIME: process.env.PLAYON_RUNTIME ?? "docker",
      CI: process.env.CI ?? "1",
    },
    maxBuffer: 16 * 1024 * 1024,
  });
  const durationMs = Date.now() - started;
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  const code = result.status ?? 1;
  const combined = `${stdout}\n${stderr}`.trim();
  const tail = combined.split(/\r?\n/).slice(-40).join("\n");
  return {
    name,
    ok: code === 0,
    code,
    durationMs,
    needs: layer.needs,
    tail,
  };
}

const layers = selectedLayers();
const startedAt = new Date().toISOString();
const results = [];
let failed = null;

for (const name of layers) {
  const result = runLayer(name);
  results.push({
    name: result.name,
    ok: result.ok,
    code: result.code,
    durationMs: result.durationMs,
    needs: result.needs,
    tail: result.ok ? undefined : result.tail,
  });
  if (!result.ok) {
    failed = result;
    break;
  }
}

mkdirSync(join(root, "tmp"), { recursive: true });
const status = {
  ok: !failed,
  startedAt,
  finishedAt: new Date().toISOString(),
  mode: args.has("--runtime")
    ? "runtime"
    : args.has("--fast")
      ? "fast"
      : args.has("--layer")
        ? "single"
        : "merge",
  layersRequested: layers,
  layersRun: results.map((r) => r.name),
  failedLayer: failed?.name ?? null,
  results,
  nextAction: failed
    ? `Fix failures in layer "${failed.name}", then re-run: pnpm loop:verify${args.has("--runtime") ? ":runtime" : ""}`
    : "Merge bar green. Pick the next plan todo and implement; re-run loop before claiming done.",
};
writeFileSync(statusPath, `${JSON.stringify(status, null, 2)}\n`, "utf8");

console.log("\n==> agent-loop summary");
console.log(`status_file=${statusPath}`);
console.log(`ok=${status.ok}`);
for (const r of results) {
  console.log(
    `layer:${r.name} ok=${r.ok} code=${r.code} duration_ms=${r.durationMs}`,
  );
}
if (failed) {
  console.log(`\nFAILED layer=${failed.name}`);
  console.log(failed.tail);
  console.log(`\n${status.nextAction}`);
  // Close the SDLC loop: lab red → GitHub needs-triage (source:lab)
  if ((process.env.PLAYON_LAB_FILE_ISSUES ?? "1") !== "0") {
    const filer = join(scriptsDir, "lab-file-github-issues.mjs");
    const filed = spawnSync(process.execPath, [filer, "--from", "verify"], {
      cwd: root,
      encoding: "utf8",
      env: process.env,
      maxBuffer: 4 * 1024 * 1024,
    });
    if (filed.stdout) console.log(filed.stdout.trimEnd());
    if (filed.stderr) console.error(filed.stderr.trimEnd());
  }
  if ((process.env.PLAYON_LAB_PUBLISH_STATUS ?? "1") !== "0") {
    const publisher = join(scriptsDir, "lab-publish-status.mjs");
    spawnSync(process.execPath, [publisher, "--force"], {
      cwd: root,
      encoding: "utf8",
      env: process.env,
      maxBuffer: 4 * 1024 * 1024,
    });
  }
  process.exit(failed.code || 1);
}

console.log(`\n${status.nextAction}`);
if ((process.env.PLAYON_LAB_PUBLISH_STATUS ?? "1") !== "0") {
  const publisher = join(scriptsDir, "lab-publish-status.mjs");
  spawnSync(process.execPath, [publisher, "--force"], {
    cwd: root,
    encoding: "utf8",
    env: process.env,
  });
}
process.exit(0);
