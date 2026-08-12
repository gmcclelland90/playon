#!/usr/bin/env node
/**
 * LLM model canary v2 (issue #845 / #836).
 *
 * Two-step tool trace on a disposable lab-* fixture. Venice is required.
 * If Ollama is reachable on this host, also canary llama3.2 / qwen2.5; if not,
 * report reachable=false without failing the Venice path.
 *
 * Never friends live servers. Does not blocklist Gemma.
 *
 * Usage:
 *   pnpm lab:llm-canary
 *
 * Env:
 *   PLAYON_VENICE_API_KEY / VENICE_API_KEY
 *   PLAYON_VENICE_BASE_URL
 *   PLAYON_LLM_CANARY_VENICE_MODELS   comma list (default llama-3.2-3b)
 *   PLAYON_LLM_CANARY_OLLAMA_MODELS   comma list (default llama3.2,qwen2.5)
 *   PLAYON_OLLAMA_BASE_URL            default http://127.0.0.1:11434
 *
 * Artifact: tmp/lab-llm-canary-status.json
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const distPath = join(root, "packages", "agent-core", "dist", "llm-canary.js");
const statusPath = join(root, "tmp", "lab-llm-canary-status.json");

function ensureDist() {
  if (existsSync(distPath)) return;
  console.log("building @playon/agent-core…");
  const r = spawnSync("pnpm", ["--filter", "@playon/agent-core", "build"], {
    cwd: root,
    encoding: "utf8",
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if ((r.status ?? 1) !== 0 || !existsSync(distPath)) {
    console.error("failed to build @playon/agent-core");
    process.exit(2);
  }
}

function printReport(report) {
  console.log(`llm-canary veniceOk=${report.veniceOk} ollama.reachable=${report.ollama.reachable}`);
  if (!report.ollama.reachable) {
    console.log("ollama reachable=false (does not fail Venice path)");
  } else {
    console.log(
      `ollama ok=${report.ollama.ok} models=${(report.ollama.models || []).join(",") || "(none)"}`,
    );
  }
  for (const row of report.models || []) {
    const flag = row.skipped ? "SKIP" : row.ok ? "PASS" : row.degraded ? "DEGRADED" : "FAIL";
    const extra = row.skipReason || row.reason || (row.names || []).join("→");
    console.log(`  ${flag} ${row.provider}/${row.model} ${extra} ${row.durationMs}ms`);
  }
}

async function main() {
  ensureDist();
  const mod = await import(pathToFileURL(distPath).href);
  const apiKey =
    process.env.PLAYON_VENICE_API_KEY?.trim() || process.env.VENICE_API_KEY?.trim() || "";
  const report = await mod.runLlmModelCanary({
    venice: apiKey
      ? {
          apiKey,
          baseUrl: process.env.PLAYON_VENICE_BASE_URL?.trim(),
        }
      : undefined,
    ollama: {
      baseUrl: process.env.PLAYON_OLLAMA_BASE_URL?.trim(),
    },
  });

  mkdirSync(join(root, "tmp"), { recursive: true });
  writeFileSync(statusPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  printReport(report);
  console.log(`wrote ${statusPath}`);

  if (!report.ok) {
    console.error("llm-canary venice path failed");
    process.exit(1);
  }
  console.log("llm-canary=ok");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
