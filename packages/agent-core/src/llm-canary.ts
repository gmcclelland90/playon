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

/** Cheap Venice default for the standing canary. Override with PLAYON_LLM_CANARY_VENICE_MODELS. */
export const DEFAULT_VENICE_CANARY_MODELS = ["llama-3.2-3b"];

/** Suggested Ollama tags from Settings. Skip (do not fail Venice) when missing. */
export const DEFAULT_OLLAMA_CANARY_MODELS = ["llama3.2", "qwen2.5"];

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
};

export type LlmCanaryReport = {
  /** Venice two-step path. Ollama miss/fail never flips this to false. */
  ok: boolean;
  veniceOk: boolean;
  ollama: OllamaReachability & { ok: boolean | null };
  models: CanaryModelResult[];
  at: string;
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
  return {
    provider,
    model,
    ok: result.ok,
    degraded: result.degraded || Boolean(result.degradedMode),
    reason: result.reason,
    names: result.names,
    durationMs: result.durationMs,
  };
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
  };
}
