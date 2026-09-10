/**
 * LLM model canary v2 — two-step tool trace on a disposable lab-* fixture.
 *
 * Used by the standing lab canary (`pnpm lab:llm-canary`) and the agent verify
 * layer. Never friends live servers. Does not blocklist Gemma.
 */
import { OpenAICompatibleLlmClient, type LlmClient } from "./llm.js";
import { Orchestrator, type OrchestratorResult, type ToolTraceEntry } from "./orchestrator.js";

export const LAB_CANARY_SERVER_ID = "lab-llm-canary";
export const LAB_CANARY_SERVER_NAME = "lab-llm-canary";
export const LAB_CANARY_SKILL = "fixtures.lab-docker-server";

/** Cheap Venice default for the in-process canary. Override with PLAYON_LLM_CANARY_VENICE_MODELS. */
export const DEFAULT_VENICE_CANARY_MODELS = ["llama-3.2-3b"];

/**
 * Cheap + mid Venice matrix for the Home API path (`pnpm lab:llm-canary --home`).
 * Skips the production default (grok-4-6). Do not add Gemma (#838).
 */
export const DEFAULT_HOME_VENICE_CANARY_MODELS = [
  "llama-3.2-3b",
  "qwen3-5-9b",
  "mistral-small-3-2-24b-instruct",
  "llama-3.3-70b",
];

/** Probe models that must not become the restore snapshot if a prior run left them on. */
export const HOME_CANARY_LEFTOVER_MODELS = [
  ...DEFAULT_HOME_VENICE_CANARY_MODELS,
  "google-gemma-3-27b-it",
  "qwen3-6-27b",
  "deepseek-v4-flash",
  "openai-gpt-4o-mini-2024-07-18",
  "qwen3-next-80b",
  "kimi-k2-5",
  "zai-org-glm-4.7-flash",
];

/** Lab Home heal target when a leftover canary model is on Settings. Does not change the preset default. */
export const DEFAULT_HOME_RESTORE_PRESET = "venice";
export const DEFAULT_HOME_RESTORE_MODEL = "grok-4-6";

/**
 * Suggested Ollama tags from Settings. Prefer tool-capable tags first
 * (`qwen2.5` over `llama3.2`; #836 / #945). Skip (do not fail Venice) when missing.
 */
export const DEFAULT_OLLAMA_CANARY_MODELS = ["qwen2.5", "llama3.2"];

export const MUTATING_CANARY_TOOLS = new Set([
  "servers_create_from_skill",
  "servers_import_local",
  "servers_import_sftp",
  "servers_start",
  "servers_stop",
  "servers_restart",
  "servers_delete",
  "servers_remove",
  "servers_wipe",
  "panel_publish",
]);

/** Live / friend inventory must never appear in canary tool args or results. */
export const FRIEND_SERVER_RE = /newzombieland|\bnzl\b|playon-node-1/i;

export const TWO_STEP_PROMPT = [
  "Disposable lab fixture only. Never touch friend or live servers.",
  "1. Call servers_list.",
  "2. Then call servers_get using the serverId from that list (it will be lab-llm-canary).",
  "Do not create, start, stop, delete, publish, or friend any server.",
  "Do not call tools for any server whose id or name does not start with lab-.",
].join(" ");

const LAB_SKILLS = [{ name: LAB_CANARY_SKILL }];
const LAB_SERVERS = [
  {
    id: LAB_CANARY_SERVER_ID,
    name: LAB_CANARY_SERVER_NAME,
    skillName: LAB_CANARY_SKILL,
  },
];

export type TwoStepTraceVerdict = {
  ok: boolean;
  /** True when the model did not complete a real two-step tool trace. */
  degraded: boolean;
  reason?: string;
  names: string[];
};

export function collectStringValues(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string" && value.trim()) {
    out.push(value.trim());
    return out;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    out.push(String(value));
    return out;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStringValues(item, out);
    return out;
  }
  if (value && typeof value === "object") {
    for (const nested of Object.values(value as Record<string, unknown>)) {
      collectStringValues(nested, out);
    }
  }
  return out;
}

function nonLabTarget(value: string): boolean {
  const v = value.trim();
  if (!v) return false;
  if (FRIEND_SERVER_RE.test(v)) return true;
  if (v.startsWith("lab-") || v.startsWith("fixtures.lab-")) return false;
  if (/^(games\.|playon-)/i.test(v)) return true;
  return false;
}

export function assertTwoStepToolTrace(trace: ToolTraceEntry[]): TwoStepTraceVerdict {
  const names = trace.map((t) => t.name);
  if (trace.some((t) => MUTATING_CANARY_TOOLS.has(t.name))) {
    return { ok: false, degraded: false, reason: "mutating_tool", names };
  }

  const hay = JSON.stringify(trace);
  if (FRIEND_SERVER_RE.test(hay)) {
    return { ok: false, degraded: false, reason: "friend_server", names };
  }

  for (const entry of trace) {
    for (const value of collectStringValues(entry.arguments)) {
      if (nonLabTarget(value)) {
        return { ok: false, degraded: false, reason: "non_lab_target", names };
      }
    }
  }

  if (trace.length < 2) {
    return { ok: false, degraded: true, reason: "need_two_tools", names };
  }

  const first = trace[0]!;
  const second = trace[1]!;
  if (first.name !== "servers_list" && first.name !== "skill_list") {
    return { ok: false, degraded: true, reason: "unexpected_first_tool", names };
  }

  const fromFirst = collectStringValues(first.result).filter((v) => v.length >= 3);
  const secondHay = JSON.stringify(second.arguments);
  const used = fromFirst.some((v) => secondHay.includes(v));
  if (!used) {
    return { ok: false, degraded: true, reason: "followup_did_not_use_result", names };
  }

  return { ok: true, degraded: false, names };
}

export type OllamaReachability = {
  reachable: boolean;
  models: string[];
  version?: string;
  baseUrl: string;
};

export async function probeOllamaReachable(
  baseUrl = process.env.PLAYON_OLLAMA_BASE_URL?.trim() || "http://127.0.0.1:11434",
  fetchImpl: typeof fetch = fetch,
): Promise<OllamaReachability> {
  const native = baseUrl.replace(/\/+$/, "").replace(/\/v1$/i, "");
  try {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 4_000);
    try {
      const res = await fetchImpl(`${native}/api/tags`, { signal: ac.signal });
      if (!res.ok) return { reachable: false, models: [], baseUrl: native };
      const json = (await res.json()) as { models?: Array<{ name?: string }> };
      const models = (json.models ?? [])
        .map((m) => String(m.name ?? "").trim())
        .filter(Boolean);
      return { reachable: true, models, baseUrl: native };
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return { reachable: false, models: [], baseUrl: native };
  }
}

export function ollamaModelInstalled(installed: string[], wanted: string): boolean {
  const want = wanted.toLowerCase();
  return installed.some((name) => {
    const n = name.toLowerCase();
    const tag = n.split(":")[0] ?? n;
    return n === want || n.startsWith(`${want}:`) || tag === want;
  });
}

export type LlmCanaryFailureClass = "skip" | "ok" | "product" | "flake" | "degraded";

export const LLM_CANARY_PRODUCT_REASONS = new Set([
  "mutating_tool",
  "friend_server",
  "non_lab_target",
  "fake_tool_json",
  "empty_function_name",
]);

export const LLM_CANARY_FLAKE_REASONS = new Set([
  "disconnect",
  "empty_tool_trace",
  "http_5xx",
  "timeout",
  "restore_verify",
  "teardown_leftover",
]);

export const LLM_CANARY_DEGRADED_REASONS = new Set([
  "need_two_tools",
  "followup_did_not_use_result",
  "unexpected_first_tool",
  "partial_trace",
]);

export function classifyLlmCanaryFailure(row: {
  ok?: boolean;
  skipped?: boolean;
  degraded?: boolean;
  reason?: string;
}): LlmCanaryFailureClass {
  if (row.skipped) return "skip";
  if (row.ok) return "ok";
  const reason = String(row.reason ?? "").trim();
  const lower = reason.toLowerCase();
  if (LLM_CANARY_PRODUCT_REASONS.has(reason)) return "product";
  if (LLM_CANARY_FLAKE_REASONS.has(reason)) return "flake";
  if (LLM_CANARY_DEGRADED_REASONS.has(reason) || row.degraded) return "degraded";
  if (/\bdisconnect\b|empty.?tool|econnreset|socket hang up/.test(lower)) return "flake";
  if (/\b(502|503|504|http_5xx)\b/.test(lower)) return "flake";
  if (/\btimeout\b/.test(lower)) return "flake";
  if (/fake tool json|emitted fake tool/.test(lower)) return "product";
  if (/empty function name/.test(lower)) return "product";
  if (/partial_trace/.test(lower)) return "degraded";
  return "product";
}

export function shouldFileLlmCanaryFailure(row: {
  ok?: boolean;
  skipped?: boolean;
  degraded?: boolean;
  reason?: string;
  failureClass?: LlmCanaryFailureClass;
}): boolean {
  const klass = row.failureClass ?? classifyLlmCanaryFailure(row);
  return klass === "product";
}

export type LlmPublicSnapshot = {
  preset?: string;
  provider?: string;
  model?: string;
  baseUrl?: string;
};

export function llmSettingsMatch(a?: LlmPublicSnapshot | null, b?: LlmPublicSnapshot | null): boolean {
  if (!a || !b) return false;
  return (
    String(a.preset ?? "") === String(b.preset ?? "") &&
    String(a.provider ?? "") === String(b.provider ?? "") &&
    String(a.model ?? "") === String(b.model ?? "")
  );
}

export function restorePutBody(snapshot: LlmPublicSnapshot): {
  preset?: string;
  provider?: string;
  model?: string;
  baseUrl?: string;
} {
  const body: { preset?: string; provider?: string; model?: string; baseUrl?: string } = {};
  if (snapshot.preset) body.preset = snapshot.preset;
  else if (snapshot.provider) body.provider = snapshot.provider;
  if (snapshot.model) body.model = snapshot.model;
  if (snapshot.baseUrl) body.baseUrl = snapshot.baseUrl;
  return body;
}

export function isHomeCanaryLeftoverModel(
  model: string | undefined,
  leftoverModels: readonly string[] = HOME_CANARY_LEFTOVER_MODELS,
): boolean {
  const want = String(model ?? "").trim().toLowerCase();
  if (!want) return false;
  return leftoverModels.some((m) => m.toLowerCase() === want);
}

export function resolveRestoreTarget(opts: {
  current: LlmPublicSnapshot;
  persisted?: LlmPublicSnapshot | null;
  leftoverModels?: readonly string[];
  healTo?: LlmPublicSnapshot;
}): { snapshot: LlmPublicSnapshot; healed: boolean; reason: string } {
  const healTo = opts.healTo ?? {
    preset: DEFAULT_HOME_RESTORE_PRESET,
    provider: "openai_compatible",
    model: DEFAULT_HOME_RESTORE_MODEL,
  };
  if (opts.persisted && !llmSettingsMatch(opts.current, opts.persisted)) {
    return { snapshot: opts.persisted, healed: true, reason: "persisted_restore" };
  }
  if (opts.persisted) {
    return { snapshot: opts.persisted, healed: false, reason: "persisted_match" };
  }
  if (isHomeCanaryLeftoverModel(opts.current.model, opts.leftoverModels)) {
    return { snapshot: healTo, healed: true, reason: "leftover_canary_model" };
  }
  return { snapshot: opts.current, healed: false, reason: "current" };
}

export function isDisposableLlmCanaryFixture(server: { id?: string; name?: string } | null | undefined): boolean {
  const id = String(server?.id ?? "");
  const name = String(server?.name ?? "");
  if (!id && !name) return false;
  if (FRIEND_SERVER_RE.test(id) || FRIEND_SERVER_RE.test(name)) return false;
  const labId = id.startsWith("lab-");
  const labName = name.startsWith("lab-");
  if (!labId && !labName) return false;
  return (
    id === LAB_CANARY_SERVER_ID ||
    name === LAB_CANARY_SERVER_NAME ||
    id.startsWith(`${LAB_CANARY_SERVER_ID}`) ||
    name.startsWith(`${LAB_CANARY_SERVER_NAME}`)
  );
}

export function mapHomeChatFailure(err: unknown): { reason: string; flake: boolean } {
  const message = err instanceof Error ? err.message : String(err ?? "");
  const lower = message.toLowerCase();
  if (/\b(502|503|504)\b/.test(lower) || /home_rest_5\d\d/.test(lower)) {
    return { reason: "http_5xx", flake: true };
  }
  if (/\btimeout\b|aborted|abort_error/.test(lower)) {
    return { reason: "timeout", flake: true };
  }
  if (/\bdisconnect\b|econnreset|socket hang up|fetch failed|econnrefused/.test(lower)) {
    return { reason: "disconnect", flake: true };
  }
  if (/empty.?tool|tooltrace/.test(lower)) {
    return { reason: "empty_tool_trace", flake: true };
  }
  return { reason: message.slice(0, 160) || "chat_failed", flake: false };
}

export type CanaryModelResult = {
  provider: "venice" | "ollama";
  model: string;
  ok: boolean;
  degraded: boolean;
  skipped?: boolean;
  skipReason?: string;
  reason?: string;
  names?: string[];
  durationMs: number;
  failureClass?: LlmCanaryFailureClass;
};

export type LlmCanaryRestoreReport = {
  ok: boolean;
  attempts: number;
  healed: boolean;
  reason: string;
  from?: LlmPublicSnapshot;
  to?: LlmPublicSnapshot;
  error?: string;
};

export type LlmCanaryTeardownReport = {
  ok: boolean;
  deleted: string[];
  remaining: string[];
  error?: string;
};

export type LlmCanaryReport = {
  /** Venice two-step path. Ollama miss/fail never flips this to false. Restore/teardown may. */
  ok: boolean;
  veniceOk: boolean;
  ollama: OllamaReachability & { ok: boolean | null };
  models: CanaryModelResult[];
  at: string;
  mode?: "in-process" | "home";
  restore?: LlmCanaryRestoreReport;
  teardown?: LlmCanaryTeardownReport;
};

export function registerLabCanaryTools(orch: Orchestrator): void {
  orch.registerTool(
    {
      name: "servers_list",
      description: "List disposable lab servers only",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
    async () => ({ servers: LAB_SERVERS }),
  );
  orch.registerTool(
    {
      name: "servers_get",
      description: "Get one lab server by id",
      parameters: {
        type: "object",
        properties: { serverId: { type: "string" } },
        required: ["serverId"],
      },
    },
    async (args) => {
      const serverId = String(args.serverId ?? "");
      if (!serverId.startsWith("lab-")) {
        return { error: "refused_non_lab_server" };
      }
      const server = LAB_SERVERS.find((s) => s.id === serverId);
      return server ? { server } : { error: "not_found" };
    },
  );
  orch.registerTool(
    {
      name: "skill_list",
      description: "List lab fixture skills",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
    async () => ({ skills: LAB_SKILLS }),
  );
}

export async function runTwoStepCanary(
  llm: LlmClient,
): Promise<TwoStepTraceVerdict & { durationMs: number; degradedMode?: boolean; content: string }> {
  const started = Date.now();
  const orch = new Orchestrator(llm, {
    confirmPolicy: "auto",
    autoApproveActor: "lab-llm-canary",
  });
  registerLabCanaryTools(orch);
  const result: OrchestratorResult = await orch.handle(TWO_STEP_PROMPT);
  const verdict = assertTwoStepToolTrace(result.toolTrace);
  return {
    ...verdict,
    durationMs: Date.now() - started,
    degradedMode: result.degradedMode,
    content: result.content,
  };
}

function parseModelList(raw: string | undefined, fallback: string[]): string[] {
  if (!raw?.trim()) return fallback;
  return raw
    .split(/[, \n]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export function veniceCanaryModelsFromEnv(): string[] {
  return parseModelList(process.env.PLAYON_LLM_CANARY_VENICE_MODELS, DEFAULT_VENICE_CANARY_MODELS);
}

export function ollamaCanaryModelsFromEnv(): string[] {
  return parseModelList(process.env.PLAYON_LLM_CANARY_OLLAMA_MODELS, DEFAULT_OLLAMA_CANARY_MODELS);
}

async function canaryOneModel(
  provider: "venice" | "ollama",
  model: string,
  llm: LlmClient,
): Promise<CanaryModelResult> {
  const result = await runTwoStepCanary(llm);
  const row: CanaryModelResult = {
    provider,
    model,
    ok: result.ok,
    degraded: result.degraded || Boolean(result.degradedMode),
    reason: result.reason,
    names: result.names,
    durationMs: result.durationMs,
  };
  row.failureClass = classifyLlmCanaryFailure(row);
  return row;
}

export type CanaryClientFactory = (model: string) => LlmClient;

export async function runLlmModelCanary(opts: {
  venice?: {
    apiKey?: string;
    baseUrl?: string;
    models?: string[];
    clientForModel?: CanaryClientFactory;
  };
  ollama?: {
    baseUrl?: string;
    models?: string[];
    fetchImpl?: typeof fetch;
    clientForModel?: CanaryClientFactory;
  };
}): Promise<LlmCanaryReport> {
  const models: CanaryModelResult[] = [];
  const veniceModels = opts.venice?.models ?? veniceCanaryModelsFromEnv();
  const ollamaModels = opts.ollama?.models ?? ollamaCanaryModelsFromEnv();

  let veniceOk = true;
  const veniceFactory = opts.venice?.clientForModel;
  const veniceKey = opts.venice?.apiKey?.trim();
  if (veniceFactory || veniceKey) {
    const baseUrl =
      opts.venice?.baseUrl?.trim() ||
      process.env.PLAYON_VENICE_BASE_URL?.trim() ||
      "https://api.venice.ai/api/v1";
    for (const model of veniceModels) {
      const llm =
        veniceFactory?.(model) ??
        new OpenAICompatibleLlmClient(baseUrl, veniceKey ?? "", model, "openai_compatible");
      const row = await canaryOneModel("venice", model, llm);
      models.push(row);
      if (!row.ok) veniceOk = false;
    }
  } else {
    veniceOk = false;
    models.push({
      provider: "venice",
      model: veniceModels[0] ?? DEFAULT_VENICE_CANARY_MODELS[0]!,
      ok: false,
      degraded: false,
      skipped: true,
      skipReason: "venice_api_key_required",
      durationMs: 0,
      failureClass: "skip",
    });
  }

  const ollamaProbe = await probeOllamaReachable(opts.ollama?.baseUrl, opts.ollama?.fetchImpl);
  let ollamaOk: boolean | null = null;
  if (!ollamaProbe.reachable) {
    ollamaOk = null;
  } else {
    ollamaOk = true;
    const openaiBase = `${ollamaProbe.baseUrl.replace(/\/+$/, "")}/v1`;
    for (const model of ollamaModels) {
      if (!opts.ollama?.clientForModel && !ollamaModelInstalled(ollamaProbe.models, model)) {
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
      const llm =
        opts.ollama?.clientForModel?.(model) ??
        new OpenAICompatibleLlmClient(openaiBase, "", model, "ollama");
      const row = await canaryOneModel("ollama", model, llm);
      models.push(row);
      if (!row.ok) ollamaOk = false;
    }
  }

  return {
    ok: veniceOk,
    veniceOk,
    ollama: { ...ollamaProbe, ok: ollamaOk },
    models,
    at: new Date().toISOString(),
    mode: "in-process",
  };
}
