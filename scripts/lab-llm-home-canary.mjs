/**
 * Home API LLM model-compat canary (#836).
 *
 * Temporarily PUT /api/settings/llm, POST /api/chat on a disposable
 * lab-llm-canary fixture, then always restore the snapshotted (or healed)
 * Settings and delete only lab-llm-canary* inventory.
 *
 * Never friends live servers. Does not send apiKey on restore. Does not
 * change the production Settings preset default.
 *
 * Used by: pnpm lab:llm-canary --home
 */
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

export const DEFAULT_RESTORE_PERSIST_PATH = join(root, "tmp", "lab-llm-canary-restore.json");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function loadPersistedRestore(path) {
  if (!existsSync(path)) return null;
  try {
    const json = JSON.parse(readFileSync(path, "utf8"));
    if (!json || typeof json !== "object") return null;
    if (!json.preset && !json.provider && !json.model) return null;
    return json;
  } catch {
    return null;
  }
}

export function savePersistedRestore(path, snapshot) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(snapshot, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  renameSync(tmp, path);
}

export function clearPersistedRestore(path) {
  try {
    unlinkSync(path);
  } catch {
    /* already gone */
  }
}

function listServers(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.servers)) return payload.servers;
  return [];
}

export async function snapshotLlmSettings(home) {
  const json = await home.rest("/api/settings/llm");
  return json?.llm ?? json;
}

export async function restoreLlmSettings(home, snapshot, helpers, { attempts = 3, delayMs = 400 } = {}) {
  const body = helpers.restorePutBody(snapshot);
  if (!body.preset && !body.provider) {
    return { ok: false, attempts: 0, error: "restore_body_missing_preset" };
  }
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      await home.rest("/api/settings/llm", { method: "PUT", body });
      const got = await snapshotLlmSettings(home);
      if (helpers.llmSettingsMatch(got, snapshot)) {
        return { ok: true, attempts: i + 1, llm: got };
      }
      lastErr = new Error(
        `restore_verify_mismatch: want ${snapshot.preset}/${snapshot.model} got ${got?.preset}/${got?.model}`,
      );
    } catch (err) {
      lastErr = err;
    }
    if (i < attempts - 1) await sleep(delayMs);
  }
  return {
    ok: false,
    attempts,
    error: lastErr instanceof Error ? lastErr.message : String(lastErr ?? "restore_failed"),
  };
}

export function leftoverLlmCanaryFixtures(servers, helpers) {
  return (servers ?? []).filter((s) => helpers.isDisposableLlmCanaryFixture(s));
}

export async function teardownLlmCanaryFixtures(home, helpers, { attempts = 3, delayMs = 250 } = {}) {
  const deleted = [];
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    let servers;
    try {
      servers = listServers(await home.rest("/api/servers"));
    } catch (err) {
      lastErr = err;
      if (i < attempts - 1) await sleep(delayMs);
      continue;
    }
    const leftovers = leftoverLlmCanaryFixtures(servers, helpers);
    if (!leftovers.length) {
      return { ok: true, deleted, remaining: [] };
    }
    for (const server of leftovers) {
      const id = server.id;
      const name = server.name || id;
      if (!id || !helpers.isDisposableLlmCanaryFixture(server)) continue;
      try {
        if (["running", "starting", "stopping"].includes(server.status)) {
          try {
            await home.rest(`/api/servers/${id}/stop`, { method: "POST", body: {} });
          } catch {
            /* continue teardown */
          }
        }
        await home.rest(`/api/servers/${id}`, { method: "DELETE" });
        deleted.push(name);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (/home_rest_404/.test(message)) {
          deleted.push(name);
          continue;
        }
        lastErr = err;
      }
    }
    try {
      const after = leftoverLlmCanaryFixtures(listServers(await home.rest("/api/servers")), helpers);
      if (!after.length) {
        return { ok: true, deleted, remaining: [] };
      }
      lastErr = new Error(`teardown_leftover: ${after.map((s) => s.name || s.id).join(",")}`);
    } catch (err) {
      lastErr = err;
    }
    if (i < attempts - 1) await sleep(delayMs);
  }
  let remaining = [];
  try {
    remaining = leftoverLlmCanaryFixtures(listServers(await home.rest("/api/servers")), helpers).map(
      (s) => s.name || s.id,
    );
  } catch {
    /* keep lastErr */
  }
  return {
    ok: remaining.length === 0,
    deleted,
    remaining,
    error: lastErr instanceof Error ? lastErr.message : String(lastErr ?? "teardown_failed"),
  };
}

export async function ensureLlmCanaryFixture(home, helpers) {
  const servers = listServers(await home.rest("/api/servers"));
  const existing = leftoverLlmCanaryFixtures(servers, helpers)[0];
  if (existing?.id) {
    return { server: existing, created: false };
  }
  const created = await home.rest("/api/servers", {
    method: "POST",
    body: {
      skillName: helpers.LAB_CANARY_SKILL,
      serverName: helpers.LAB_CANARY_SERVER_NAME,
    },
  });
  const server = created?.server ?? created;
  if (!helpers.isDisposableLlmCanaryFixture(server)) {
    throw new Error(`created_non_lab_fixture: ${server?.id ?? server?.name ?? "unknown"}`);
  }
  return { server, created: true };
}

export function classifyHomeChatResult(json, helpers) {
  const trace = Array.isArray(json?.toolTrace) ? json.toolTrace : [];
  if (!trace.length) {
    return {
      ok: false,
      degraded: true,
      reason: "empty_tool_trace",
      names: [],
      failureClass: "flake",
    };
  }
  const verdict = helpers.assertTwoStepToolTrace(trace);
  const row = {
    ok: verdict.ok,
    degraded: verdict.degraded,
    reason: verdict.reason,
    names: verdict.names,
  };
  if (row.reason === "need_two_tools" || row.reason === "followup_did_not_use_result") {
    row.reason = row.reason === "need_two_tools" ? "partial_trace" : row.reason;
  }
  row.failureClass = helpers.classifyLlmCanaryFailure(row);
  return row;
}

export async function runHomeModel(home, { provider, model, serverId, helpers, prompt }) {
  const started = Date.now();
  await home.rest("/api/settings/llm", {
    method: "PUT",
    body: { preset: provider === "ollama" ? "ollama" : "venice", model },
  });
  try {
    const json = await home.rest("/api/chat", {
      method: "POST",
      body: { message: prompt, serverId },
    });
    const verdict = classifyHomeChatResult(json, helpers);
    return {
      provider,
      model,
      ...verdict,
      durationMs: Date.now() - started,
    };
  } catch (err) {
    const mapped = helpers.mapHomeChatFailure(err);
    return {
      provider,
      model,
      ok: false,
      degraded: mapped.flake,
      reason: mapped.reason,
      names: [],
      durationMs: Date.now() - started,
      failureClass: mapped.flake ? "flake" : helpers.classifyLlmCanaryFailure({ ok: false, reason: mapped.reason }),
    };
  }
}

export async function runHomeLlmModelCanary(opts) {
  const helpers = opts.helpers;
  const persistPath = opts.persistPath ?? DEFAULT_RESTORE_PERSIST_PATH;
  const veniceModels = opts.veniceModels ?? helpers.DEFAULT_HOME_VENICE_CANARY_MODELS;
  const ollamaModels = opts.ollamaModels ?? helpers.DEFAULT_OLLAMA_CANARY_MODELS;
  const healTo = opts.healTo ?? {
    preset: helpers.DEFAULT_HOME_RESTORE_PRESET,
    provider: "openai_compatible",
    model: helpers.DEFAULT_HOME_RESTORE_MODEL,
  };

  const current = await snapshotLlmSettings(opts.home);
  const persisted = loadPersistedRestore(persistPath);
  const target = helpers.resolveRestoreTarget({ current, persisted, healTo });
  savePersistedRestore(persistPath, target.snapshot);

  const models = [];
  let veniceOk = true;
  let fixture;
  let restore;
  let teardown;

  try {
    teardown = await teardownLlmCanaryFixtures(opts.home, helpers);
    fixture = await ensureLlmCanaryFixture(opts.home, helpers);
    const serverId = fixture.server.id;

    for (const model of veniceModels) {
      const row = await runHomeModel(opts.home, {
        provider: "venice",
        model,
        serverId,
        helpers,
        prompt: helpers.TWO_STEP_PROMPT,
      });
      models.push(row);
      if (!row.ok && row.failureClass === "product") veniceOk = false;
    }

    let ollamaProbe = opts.ollama ?? { reachable: false, models: [], baseUrl: "" };
    if (opts.probeOllama) {
      ollamaProbe = await opts.probeOllama();
    }
    let ollamaOk = ollamaProbe.reachable ? true : null;
    if (ollamaProbe.reachable) {
      for (const model of ollamaModels) {
        if (!helpers.ollamaModelInstalled(ollamaProbe.models, model)) {
          models.push({
            provider: "ollama",
            model,
            ok: true,
            degraded: false,
            skipped: true,
            skipReason: "model_not_installed",
            durationMs: 0,
            failureClass: "skip",
          });
          continue;
        }
        const row = await runHomeModel(opts.home, {
          provider: "ollama",
          model,
          serverId,
          helpers,
          prompt: helpers.TWO_STEP_PROMPT,
        });
        models.push(row);
        if (!row.ok && row.failureClass === "product") ollamaOk = false;
      }
    }

    return await finalize({
      home: opts.home,
      helpers,
      persistPath,
      target,
      current,
      models,
      veniceOk,
      ollamaProbe,
      ollamaOk,
    });
  } catch (err) {
    const finalized = await finalize({
      home: opts.home,
      helpers,
      persistPath,
      target,
      current,
      models,
      veniceOk: false,
      ollamaProbe: { reachable: false, models: [], baseUrl: "", ok: null },
      ollamaOk: null,
      error: err instanceof Error ? err.message : String(err),
    });
    return finalized;
  }

  async function finalize({
    home,
    helpers: h,
    persistPath: persist,
    target: tgt,
    current: before,
    models: rows,
    veniceOk: vOk,
    ollamaProbe,
    ollamaOk,
    error,
  }) {
    restore = await restoreLlmSettings(home, tgt.snapshot, h);
    teardown = await teardownLlmCanaryFixtures(home, h);
    if (restore.ok) clearPersistedRestore(persist);
    const report = {
      ok: Boolean(vOk && restore.ok && teardown.ok),
      veniceOk: vOk,
      ollama: { ...ollamaProbe, ok: ollamaOk ?? (ollamaProbe.reachable ? true : null) },
      models: rows,
      at: new Date().toISOString(),
      mode: "home",
      restore: {
        ok: restore.ok,
        attempts: restore.attempts,
        healed: tgt.healed,
        reason: tgt.reason,
        from: before,
        to: restore.llm ?? tgt.snapshot,
        error: restore.error,
      },
      teardown: {
        ok: teardown.ok,
        deleted: teardown.deleted,
        remaining: teardown.remaining,
        error: teardown.error,
      },
      error,
    };
    return report;
  }
}

export async function openHomeClient(repoRoot = root) {
  const { HomeClient, loadHomeAuth, windowsPlacementConfig } = await import(
    "./lab-matrix-home-client.mjs"
  );
  const cfg = windowsPlacementConfig(repoRoot);
  const auth = await loadHomeAuth(cfg);
  return new HomeClient(auth);
}

export async function restoreOnly(home, helpers, persistPath = DEFAULT_RESTORE_PERSIST_PATH) {
  const current = await snapshotLlmSettings(home);
  const persisted = loadPersistedRestore(persistPath);
  const target = helpers.resolveRestoreTarget({ current, persisted });
  const restore = await restoreLlmSettings(home, target.snapshot, helpers);
  if (restore.ok) clearPersistedRestore(persistPath);
  return { current, target, restore };
}

export async function teardownOnly(home, helpers) {
  return teardownLlmCanaryFixtures(home, helpers);
}
