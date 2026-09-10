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
 *   pnpm lab:llm-canary              # in-process two-step (no Home mutation)
 *   pnpm lab:llm-canary --home       # Home Settings+Chat with restore/teardown
 *   pnpm lab:llm-canary --restore-only
 *   pnpm lab:llm-canary --teardown-only
 *
 * Env:
 *   PLAYON_VENICE_API_KEY / VENICE_API_KEY
 *   PLAYON_VENICE_BASE_URL
 *   PLAYON_LLM_CANARY_VENICE_MODELS   comma list (in-process default llama-3.2-3b;
 *                                     --home default cheap+mid matrix)
 *   PLAYON_LLM_CANARY_OLLAMA_MODELS   comma list (default qwen2.5,llama3.2)
 *   PLAYON_OLLAMA_BASE_URL            default http://127.0.0.1:11434
 *   PLAYON_LLM_CANARY_HOME=1          same as --home
 *   PLAYON_LLM_CANARY_RESTORE_PRESET  leftover heal preset (default venice)
 *   PLAYON_LLM_CANARY_RESTORE_MODEL   leftover heal model (default grok-4-6)
 *
 * Artifact: tmp/lab-llm-canary-status.json
 * Persist:  tmp/lab-llm-canary-restore.json (crash-safe Settings snapshot)
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
  console.log(
    `llm-canary mode=${report.mode || "in-process"} veniceOk=${report.veniceOk} ollama.reachable=${report.ollama.reachable}`,
  );
  if (!report.ollama.reachable) {
    console.log("ollama reachable=false (does not fail Venice path)");
  } else {
    console.log(
      `ollama ok=${report.ollama.ok} models=${(report.ollama.models || []).join(",") || "(none)"}`,
    );
  }
  if (report.restore) {
    const flag = report.restore.ok ? "PASS" : "FAIL";
    console.log(
      `  ${flag} restore healed=${report.restore.healed} reason=${report.restore.reason} ${report.restore.to?.preset || ""}/${report.restore.to?.model || ""} attempts=${report.restore.attempts}`,
    );
    if (report.restore.error) console.log(`    restore error: ${report.restore.error}`);
  }
  if (report.teardown) {
    const flag = report.teardown.ok ? "PASS" : "FAIL";
    console.log(
      `  ${flag} teardown deleted=${(report.teardown.deleted || []).join(",") || "(none)"} remaining=${(report.teardown.remaining || []).join(",") || "(none)"}`,
    );
    if (report.teardown.error) console.log(`    teardown error: ${report.teardown.error}`);
  }
  for (const row of report.models || []) {
    const flag = row.skipped ? "SKIP" : row.ok ? "PASS" : row.degraded ? "DEGRADED" : "FAIL";
    const klass = row.failureClass ? ` class=${row.failureClass}` : "";
    const extra = row.skipReason || row.reason || (row.names || []).join("→");
    console.log(`  ${flag} ${row.provider}/${row.model} ${extra}${klass} ${row.durationMs}ms`);
  }
}

function argvFlags() {
  const argv = process.argv.slice(2);
  return {
    home: argv.includes("--home") || process.env.PLAYON_LLM_CANARY_HOME?.trim() === "1",
    restoreOnly: argv.includes("--restore-only"),
    teardownOnly: argv.includes("--teardown-only"),
  };
}

async function loadHelpers(mod) {
  return {
    LAB_CANARY_SERVER_ID: mod.LAB_CANARY_SERVER_ID,
    LAB_CANARY_SERVER_NAME: mod.LAB_CANARY_SERVER_NAME,
    LAB_CANARY_SKILL: mod.LAB_CANARY_SKILL,
    TWO_STEP_PROMPT: mod.TWO_STEP_PROMPT,
    DEFAULT_HOME_VENICE_CANARY_MODELS: mod.DEFAULT_HOME_VENICE_CANARY_MODELS,
    DEFAULT_OLLAMA_CANARY_MODELS: mod.DEFAULT_OLLAMA_CANARY_MODELS,
    DEFAULT_HOME_RESTORE_PRESET: mod.DEFAULT_HOME_RESTORE_PRESET,
    DEFAULT_HOME_RESTORE_MODEL: mod.DEFAULT_HOME_RESTORE_MODEL,
    llmSettingsMatch: mod.llmSettingsMatch,
    restorePutBody: mod.restorePutBody,
    resolveRestoreTarget: mod.resolveRestoreTarget,
    isDisposableLlmCanaryFixture: mod.isDisposableLlmCanaryFixture,
    assertTwoStepToolTrace: mod.assertTwoStepToolTrace,
    classifyLlmCanaryFailure: mod.classifyLlmCanaryFailure,
    mapHomeChatFailure: mod.mapHomeChatFailure,
    ollamaModelInstalled: mod.ollamaModelInstalled,
    probeOllamaReachable: mod.probeOllamaReachable,
    veniceCanaryModelsFromEnv: mod.veniceCanaryModelsFromEnv,
    ollamaCanaryModelsFromEnv: mod.ollamaCanaryModelsFromEnv,
  };
}

function writeStatus(report) {
  mkdirSync(join(root, "tmp"), { recursive: true });
  writeFileSync(statusPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  printReport(report);
  console.log(`wrote ${statusPath}`);
}

async function main() {
  ensureDist();
  const flags = argvFlags();
  const mod = await import(pathToFileURL(distPath).href);

  if (flags.home || flags.restoreOnly || flags.teardownOnly) {
    const homeMod = await import(pathToFileURL(join(root, "scripts", "lab-llm-home-canary.mjs")).href);
    const helpers = await loadHelpers(mod);
    const home = await homeMod.openHomeClient(root);
    if (flags.restoreOnly) {
      const result = await homeMod.restoreOnly(home, helpers);
      console.log(
        `restore-only ok=${result.restore.ok} healed=${result.target.healed} ${result.target.snapshot.preset}/${result.target.snapshot.model}`,
      );
      if (result.restore.error) console.error(result.restore.error);
      process.exit(result.restore.ok ? 0 : 2);
    }
    if (flags.teardownOnly) {
      const teardown = await homeMod.teardownOnly(home, helpers);
      console.log(
        `teardown-only ok=${teardown.ok} deleted=${(teardown.deleted || []).join(",") || "(none)"} remaining=${(teardown.remaining || []).join(",") || "(none)"}`,
      );
      if (teardown.error) console.error(teardown.error);
      process.exit(teardown.ok ? 0 : 2);
    }

    const healTo = {
      preset: process.env.PLAYON_LLM_CANARY_RESTORE_PRESET?.trim() || helpers.DEFAULT_HOME_RESTORE_PRESET,
      provider: "openai_compatible",
      model: process.env.PLAYON_LLM_CANARY_RESTORE_MODEL?.trim() || helpers.DEFAULT_HOME_RESTORE_MODEL,
    };
    const envVenice = process.env.PLAYON_LLM_CANARY_VENICE_MODELS?.trim();
    const report = await homeMod.runHomeLlmModelCanary({
      home,
      helpers,
      veniceModels: envVenice
        ? helpers.veniceCanaryModelsFromEnv()
        : helpers.DEFAULT_HOME_VENICE_CANARY_MODELS,
      ollamaModels: helpers.ollamaCanaryModelsFromEnv(),
      healTo,
      probeOllama: () => helpers.probeOllamaReachable(),
    });
    writeStatus(report);
    if (!report.restore?.ok || !report.teardown?.ok) {
      console.error("llm-canary restore/teardown failed");
      process.exit(2);
    }
    if (!report.veniceOk) {
      console.error("llm-canary venice path failed (product)");
      process.exit(1);
    }
    console.log("llm-canary=ok");
    return;
  }

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

  writeStatus(report);

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
