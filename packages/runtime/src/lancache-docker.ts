/**
 * Manage upstream lancachenet containers via Docker CLI (infra, not game ContainerSpec).
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export const LANCACHE_CONTAINER = "playon-lancache";
export const LANCACHE_DNS_CONTAINER = "playon-lancache-dns";
export const LANCACHE_IMAGE = "lancachenet/monolithic:latest";
export const LANCACHE_DNS_IMAGE = "lancachenet/lancache-dns:latest";

export type DockerRunner = (
  args: string[],
  opts?: { timeoutMs?: number },
) => Promise<{ code: number; stdout: string; stderr: string }>;

export const defaultDockerRunner: DockerRunner = (args, opts) =>
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

async function containerRunning(
  name: string,
  docker: DockerRunner,
): Promise<boolean> {
  const r = await docker(["inspect", "-f", "{{.State.Running}}", name], {
    timeoutMs: 15_000,
  });
  return r.code === 0 && r.stdout.trim() === "true";
}

async function removeContainer(name: string, docker: DockerRunner): Promise<void> {
  await docker(["rm", "-f", name], { timeoutMs: 60_000 }).catch(() => undefined);
}

function dirBytes(dir: string): number {
  if (!fs.existsSync(dir)) return 0;
  let total = 0;
  const walk = (p: string) => {
    for (const name of fs.readdirSync(p)) {
      const abs = path.join(p, name);
      const st = fs.statSync(abs);
      if (st.isDirectory()) walk(abs);
      else total += st.size;
    }
  };
  try {
    walk(dir);
  } catch {
    return 0;
  }
  return total;
}

/** Build docker run args for monolithic (exported for unit tests). */
export function monolithicRunArgs(dataPath: string): string[] {
  return [
    "run",
    "-d",
    "--name",
    LANCACHE_CONTAINER,
    "--restart",
    "unless-stopped",
    "-v",
    `${dataPath}:/data/cache`,
    "-p",
    "80:80",
    "-p",
    "443:443",
    LANCACHE_IMAGE,
  ];
}

/** Build docker run args for lancache-dns. */
export function dnsRunArgs(cacheIp: string): string[] {
  return [
    "run",
    "-d",
    "--name",
    LANCACHE_DNS_CONTAINER,
    "--restart",
    "unless-stopped",
    "-p",
    "53:53/udp",
    "-p",
    "53:53/tcp",
    "-e",
    `LANCACHE_IP=${cacheIp}`,
    LANCACHE_DNS_IMAGE,
  ];
}

export async function runLancacheEnsure(opts: {
  dataPath: string;
  cacheIp?: string;
  docker?: DockerRunner;
}): Promise<{
  ok: true;
  running: boolean;
  container: string;
  image: string;
  dataPath: string;
  pulled: boolean;
}> {
  if (process.platform === "win32") {
    throw new Error("lancache_linux_only");
  }
  const docker = opts.docker ?? defaultDockerRunner;
  const dataPath = path.resolve(opts.dataPath);
  fs.mkdirSync(dataPath, { recursive: true });

  const pull = await docker(["pull", LANCACHE_IMAGE], { timeoutMs: 600_000 });
  if (pull.code !== 0) {
    throw new Error(`lancache_pull_failed: ${pull.stderr.slice(-400)}`);
  }

  if (await containerRunning(LANCACHE_CONTAINER, docker)) {
    return {
      ok: true,
      running: true,
      container: LANCACHE_CONTAINER,
      image: LANCACHE_IMAGE,
      dataPath,
      pulled: true,
    };
  }

  await removeContainer(LANCACHE_CONTAINER, docker);
  const run = await docker(monolithicRunArgs(dataPath), { timeoutMs: 120_000 });
  if (run.code !== 0) {
    throw new Error(`lancache_start_failed: ${run.stderr.slice(-400)}`);
  }

  return {
    ok: true,
    running: true,
    container: LANCACHE_CONTAINER,
    image: LANCACHE_IMAGE,
    dataPath,
    pulled: true,
  };
}

export async function runLancacheDnsEnsure(opts: {
  cacheIp: string;
  docker?: DockerRunner;
}): Promise<{ ok: true; running: boolean; container: string; cacheIp: string }> {
  if (process.platform === "win32") {
    throw new Error("lancache_linux_only");
  }
  const docker = opts.docker ?? defaultDockerRunner;
  const cacheIp = opts.cacheIp.trim();
  if (!cacheIp) throw new Error("lancache_cache_ip_required");

  const pull = await docker(["pull", LANCACHE_DNS_IMAGE], { timeoutMs: 300_000 });
  if (pull.code !== 0) {
    throw new Error(`lancache_dns_pull_failed: ${pull.stderr.slice(-400)}`);
  }

  if (await containerRunning(LANCACHE_DNS_CONTAINER, docker)) {
    return { ok: true, running: true, container: LANCACHE_DNS_CONTAINER, cacheIp };
  }

  await removeContainer(LANCACHE_DNS_CONTAINER, docker);
  const run = await docker(dnsRunArgs(cacheIp), { timeoutMs: 60_000 });
  if (run.code !== 0) {
    throw new Error(`lancache_dns_start_failed: ${run.stderr.slice(-400)}`);
  }
  return { ok: true, running: true, container: LANCACHE_DNS_CONTAINER, cacheIp };
}

export async function runLancacheStatus(opts: {
  dataPath?: string;
  docker?: DockerRunner;
}): Promise<{
  running: boolean;
  dnsRunning: boolean;
  container: string;
  dnsContainer: string;
  image: string;
  dataPath?: string;
  dataDirBytes: number;
}> {
  const docker = opts.docker ?? defaultDockerRunner;
  const running = await containerRunning(LANCACHE_CONTAINER, docker);
  const dnsRunning = await containerRunning(LANCACHE_DNS_CONTAINER, docker);
  const dataPath = opts.dataPath ? path.resolve(opts.dataPath) : undefined;
  return {
    running,
    dnsRunning,
    container: LANCACHE_CONTAINER,
    dnsContainer: LANCACHE_DNS_CONTAINER,
    image: LANCACHE_IMAGE,
    dataPath,
    dataDirBytes: dataPath ? dirBytes(dataPath) : 0,
  };
}

export async function runLancacheStop(opts?: {
  docker?: DockerRunner;
}): Promise<{ ok: true; stopped: string[] }> {
  const docker = opts?.docker ?? defaultDockerRunner;
  const stopped: string[] = [];
  for (const name of [LANCACHE_DNS_CONTAINER, LANCACHE_CONTAINER]) {
    const r = await docker(["rm", "-f", name], { timeoutMs: 60_000 });
    if (r.code === 0) stopped.push(name);
  }
  return { ok: true, stopped };
}

/**
 * Operator-triggered prune: stop cache, clear data dir contents, restart monolithic if it was running.
 */
export async function runLancachePrune(opts: {
  dataPath?: string;
  docker?: DockerRunner;
}): Promise<{ ok: true; clearedBytes: number; restarted: boolean; dataPath?: string }> {
  if (process.platform === "win32") {
    throw new Error("lancache_linux_only");
  }
  const docker = opts.docker ?? defaultDockerRunner;
  const wasRunning = await containerRunning(LANCACHE_CONTAINER, docker);
  await runLancacheStop({ docker });

  const dataPath = opts.dataPath ? path.resolve(opts.dataPath) : undefined;
  let clearedBytes = 0;
  if (dataPath && fs.existsSync(dataPath)) {
    clearedBytes = dirBytes(dataPath);
    for (const name of fs.readdirSync(dataPath)) {
      fs.rmSync(path.join(dataPath, name), { recursive: true, force: true });
    }
  }

  let restarted = false;
  if (wasRunning && dataPath) {
    await runLancacheEnsure({ dataPath, docker });
    restarted = true;
  }

  return { ok: true, clearedBytes, restarted, dataPath };
}
