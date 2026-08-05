/**
 * Ollama probe / one-click Docker install / model pull for Settings.
 * Install is Home-host only (loopback); never runs during bootstrap.
 */
import { spawn } from "node:child_process";
import { dockerSocketAvailable } from "@playon/runtime";
import { LLM_PRESETS } from "@playon/shared";

export const OLLAMA_CONTAINER_NAME = "playon-ollama";
export const OLLAMA_IMAGE = "ollama/ollama";
export const OLLAMA_VOLUME = "playon-ollama";
export const DEFAULT_OLLAMA_OPENAI_BASE = LLM_PRESETS.ollama.baseUrl;

export type OllamaJobPhase = "idle" | "installing" | "pulling" | "ready" | "error";

export type OllamaModelInfo = {
  name: string;
  size?: number;
};

export type OllamaJobStatus = {
  phase: OllamaJobPhase;
  message?: string;
  updatedAt: string;
};

export type OllamaProbeResult = {
  reachable: boolean;
  version?: string;
  models: OllamaModelInfo[];
  dockerAvailable: boolean;
  canInstallLocal: boolean;
  isLoopback: boolean;
  manualCommand?: string;
  nativeBaseUrl: string;
  job: OllamaJobStatus;
};

export type DockerRunner = (
  args: string[],
  opts?: { timeoutMs?: number },
) => Promise<{ code: number; stdout: string; stderr: string }>;

export type OllamaFetch = typeof fetch;

const defaultJob = (): OllamaJobStatus => ({
  phase: "idle",
  updatedAt: new Date().toISOString(),
});

let jobState: OllamaJobStatus = defaultJob();
let activeWork: Promise<void> | null = null;

export function getOllamaJob(): OllamaJobStatus {
  return { ...jobState };
}

export function resetOllamaJobForTests(): void {
  jobState = defaultJob();
  activeWork = null;
}

function setJob(phase: OllamaJobPhase, message?: string): OllamaJobStatus {
  jobState = {
    phase,
    message,
    updatedAt: new Date().toISOString(),
  };
  return getOllamaJob();
}

/** Strip trailing `/v1` (OpenAI-compat) so native Ollama routes resolve. */
export function nativeOllamaBaseUrl(openaiCompatBaseUrl: string): string {
  const trimmed = openaiCompatBaseUrl.trim().replace(/\/+$/, "");
  if (trimmed.toLowerCase().endsWith("/v1")) {
    return trimmed.slice(0, -3).replace(/\/+$/, "") || trimmed;
  }
  return trimmed;
}

export function isLoopbackOllamaUrl(baseUrl: string): boolean {
  try {
    const u = new URL(nativeOllamaBaseUrl(baseUrl));
    const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    return (
      host === "127.0.0.1" ||
      host === "localhost" ||
      host === "::1" ||
      host === "0:0:0:0:0:0:0:1"
    );
  } catch {
    return false;
  }
}

export function manualOllamaInstallCommand(platform: NodeJS.Platform = process.platform): string {
  if (platform === "win32") {
    return "irm https://ollama.com/install.ps1 | iex";
  }
  return "curl -fsSL https://ollama.com/install.sh | sh";
}

const defaultDockerRunner: DockerRunner = (args, opts) =>
  new Promise((resolve, reject) => {
    const child = spawn("docker", args, {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer =
      opts?.timeoutMs != null
        ? setTimeout(() => {
            child.kill("SIGKILL");
            reject(new Error(`docker_timeout: ${args.join(" ")}`));
          }, opts.timeoutMs)
        : undefined;
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (err) => {
      if (timer) clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });

async function fetchJson(
  url: string,
  init: RequestInit | undefined,
  fetchImpl: OllamaFetch,
  timeoutMs: number,
): Promise<{ ok: boolean; status: number; json: unknown }> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { ...init, signal: ac.signal });
    const json = await res.json().catch(() => null);
    return { ok: res.ok, status: res.status, json };
  } finally {
    clearTimeout(timer);
  }
}

export async function probeOllama(
  openaiCompatBaseUrl: string,
  opts: {
    fetchImpl?: OllamaFetch;
    dockerAvailable?: boolean;
    platform?: NodeJS.Platform;
  } = {},
): Promise<OllamaProbeResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const dockerAvailable = opts.dockerAvailable ?? dockerSocketAvailable();
  const platform = opts.platform ?? process.platform;
  const native = nativeOllamaBaseUrl(openaiCompatBaseUrl || DEFAULT_OLLAMA_OPENAI_BASE);
  const isLoopback = isLoopbackOllamaUrl(openaiCompatBaseUrl || DEFAULT_OLLAMA_OPENAI_BASE);
  const canInstallLocal = isLoopback && dockerAvailable;
  const manualCommand =
    isLoopback && !dockerAvailable ? manualOllamaInstallCommand(platform) : undefined;

  let reachable = false;
  let version: string | undefined;
  let models: OllamaModelInfo[] = [];

  try {
    const tags = await fetchJson(`${native}/api/tags`, undefined, fetchImpl, 4_000);
    if (tags.ok && tags.json && typeof tags.json === "object") {
      reachable = true;
      const list = (tags.json as { models?: Array<{ name?: string; size?: number }> }).models ?? [];
      models = list
        .filter((m) => typeof m.name === "string" && m.name.trim())
        .map((m) => ({
          name: String(m.name),
          size: typeof m.size === "number" ? m.size : undefined,
        }));
    }
  } catch {
    reachable = false;
  }

  if (reachable) {
    try {
      const ver = await fetchJson(`${native}/api/version`, undefined, fetchImpl, 2_000);
      if (ver.ok && ver.json && typeof ver.json === "object") {
        const v = (ver.json as { version?: string }).version;
        if (typeof v === "string" && v.trim()) version = v.trim();
      }
    } catch {
      /* optional */
    }
  }

  return {
    reachable,
    version,
    models,
    dockerAvailable,
    canInstallLocal,
    isLoopback,
    manualCommand,
    nativeBaseUrl: native,
    job: getOllamaJob(),
  };
}

async function ensureOllamaContainer(runDocker: DockerRunner): Promise<void> {
  setJob("installing", "Pulling ollama/ollama image…");
  const pull = await runDocker(["pull", OLLAMA_IMAGE], { timeoutMs: 15 * 60_000 });
  if (pull.code !== 0) {
    throw new Error(
      `ollama_docker_pull_failed: ${(pull.stderr || pull.stdout || "unknown").trim().slice(0, 400)}`,
    );
  }

  setJob("installing", "Starting playon-ollama container…");
  const inspect = await runDocker(["inspect", OLLAMA_CONTAINER_NAME], { timeoutMs: 15_000 });
  if (inspect.code === 0) {
    const start = await runDocker(["start", OLLAMA_CONTAINER_NAME], { timeoutMs: 60_000 });
    if (start.code !== 0) {
      throw new Error(
        `ollama_docker_start_failed: ${(start.stderr || start.stdout || "unknown").trim().slice(0, 400)}`,
      );
    }
    return;
  }

  const run = await runDocker(
    [
      "run",
      "-d",
      "--name",
      OLLAMA_CONTAINER_NAME,
      "-v",
      `${OLLAMA_VOLUME}:/root/.ollama`,
      "-p",
      "11434:11434",
      "--restart",
      "unless-stopped",
      OLLAMA_IMAGE,
    ],
    { timeoutMs: 120_000 },
  );
  if (run.code !== 0) {
    throw new Error(
      `ollama_docker_run_failed: ${(run.stderr || run.stdout || "unknown").trim().slice(0, 400)}`,
    );
  }
}

async function waitUntilReachable(
  openaiCompatBaseUrl: string,
  fetchImpl: OllamaFetch,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const probe = await probeOllama(openaiCompatBaseUrl, {
      fetchImpl,
      dockerAvailable: true,
    });
    if (probe.reachable) return;
    await new Promise((r) => setTimeout(r, 800));
  }
  throw new Error("ollama_not_reachable_after_install: container started but API did not respond");
}

/**
 * Start one-click Docker install on the Home host. Returns immediately with job status.
 * Rejects schedule when not loopback, Docker missing, or another job is running.
 */
export function startOllamaInstall(
  openaiCompatBaseUrl: string,
  opts: {
    fetchImpl?: OllamaFetch;
    runDocker?: DockerRunner;
    dockerAvailable?: boolean;
  } = {},
): OllamaJobStatus {
  const base = openaiCompatBaseUrl.trim() || DEFAULT_OLLAMA_OPENAI_BASE;
  if (!isLoopbackOllamaUrl(base)) {
    return setJob("error", "ollama_install_local_only: set Base URL to localhost/127.0.0.1 to install here");
  }
  const dockerAvailable = opts.dockerAvailable ?? dockerSocketAvailable();
  if (!dockerAvailable) {
    return setJob(
      "error",
      `ollama_docker_unavailable: install Docker, or run: ${manualOllamaInstallCommand()}`,
    );
  }
  if (activeWork || jobState.phase === "installing" || jobState.phase === "pulling") {
    return setJob(jobState.phase, jobState.message ?? "ollama_job_busy");
  }

  const fetchImpl = opts.fetchImpl ?? fetch;
  const runDocker = opts.runDocker ?? defaultDockerRunner;
  setJob("installing", "Starting Ollama install…");

  activeWork = (async () => {
    try {
      await ensureOllamaContainer(runDocker);
      setJob("installing", "Waiting for Ollama API…");
      await waitUntilReachable(base, fetchImpl, 60_000);
      setJob("ready", "Ollama is running");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setJob("error", message);
    } finally {
      activeWork = null;
    }
  })();

  return getOllamaJob();
}

export function startOllamaPull(
  openaiCompatBaseUrl: string,
  model: string,
  opts: { fetchImpl?: OllamaFetch } = {},
): OllamaJobStatus {
  const name = model.trim();
  if (!name) {
    return setJob("error", "ollama_model_required");
  }
  if (activeWork || jobState.phase === "installing" || jobState.phase === "pulling") {
    return setJob(jobState.phase, jobState.message ?? "ollama_job_busy");
  }

  const fetchImpl = opts.fetchImpl ?? fetch;
  const native = nativeOllamaBaseUrl(openaiCompatBaseUrl.trim() || DEFAULT_OLLAMA_OPENAI_BASE);
  setJob("pulling", `Pulling ${name}…`);

  activeWork = (async () => {
    try {
      const res = await fetchJson(
        `${native}/api/pull`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ model: name, stream: false }),
        },
        fetchImpl,
        30 * 60_000,
      );
      if (!res.ok) {
        throw new Error(`ollama_pull_failed: HTTP ${res.status}`);
      }
      setJob("ready", `Pulled ${name}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setJob("error", message);
    } finally {
      activeWork = null;
    }
  })();

  return getOllamaJob();
}
