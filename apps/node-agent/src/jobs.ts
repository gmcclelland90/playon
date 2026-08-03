import fs from "node:fs";
import path from "node:path";
import {
  createRuntime,
  resolveInJail,
  steamcmdAppUpdate,
  type DockerAdapter,
  type ProcessSupervisor,
} from "@playon/runtime";
import type { NodeJobKind } from "@playon/shared";
import { probeCapabilities } from "./capabilities.js";

export type RemoteJobKind = NodeJobKind;

export interface RemoteJob {
  id: string;
  nodeId: string;
  kind: RemoteJobKind;
  args: Record<string, unknown>;
}

let dockerAdapter: DockerAdapter | null = null;
let processSupervisor: ProcessSupervisor | null = null;

async function ensureAdapters(): Promise<{
  docker: DockerAdapter | null;
  process: ProcessSupervisor;
}> {
  if (processSupervisor) {
    return { docker: dockerAdapter, process: processSupervisor };
  }
  const mode = process.env.PLAYON_RUNTIME === "native" ? "native" : "docker";
  try {
    const adapters = await createRuntime(mode);
    dockerAdapter = mode === "docker" ? adapters.docker : null;
    processSupervisor = adapters.process;
  } catch {
    const adapters = await createRuntime("native");
    dockerAdapter = null;
    processSupervisor = adapters.process;
  }
  return { docker: dockerAdapter, process: processSupervisor! };
}

export async function claimNextJob(
  apiBase: string,
  nodeId: string,
  token?: string,
): Promise<RemoteJob | null> {
  const headers: Record<string, string> = { accept: "application/json" };
  if (token?.trim()) headers.authorization = `Bearer ${token.trim()}`;
  const res = await fetch(
    `${apiBase.replace(/\/$/, "")}/api/nodes/${encodeURIComponent(nodeId)}/jobs/next`,
    { headers },
  );
  if (res.status === 204) return null;
  if (!res.ok) {
    throw new Error(`job_claim_failed: ${res.status} ${await res.text()}`);
  }
  return (await res.json()) as RemoteJob;
}

export async function reportJobResult(
  apiBase: string,
  nodeId: string,
  jobId: string,
  body: { ok: true; result: unknown } | { ok: false; error: string },
  token?: string,
): Promise<void> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token?.trim()) headers.authorization = `Bearer ${token.trim()}`;
  const res = await fetch(
    `${apiBase.replace(/\/$/, "")}/api/nodes/${encodeURIComponent(nodeId)}/jobs/${encodeURIComponent(jobId)}/result`,
    {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    },
  );
  if (!res.ok) {
    throw new Error(`job_result_failed: ${res.status} ${await res.text()}`);
  }
}

function strArg(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  if (typeof v !== "string" || !v.trim()) throw new Error(`missing_arg: ${key}`);
  return v;
}

/** Execute a claimed job locally with path jail under dataRoot. */
export async function executeJob(job: RemoteJob, dataRoot: string): Promise<unknown> {
  if (job.kind === "ping") {
    return {
      pong: true,
      nodeId: job.nodeId,
      dataRoot,
      at: new Date().toISOString(),
    };
  }

  if (job.kind === "runtime_caps") {
    return probeCapabilities(dataRoot);
  }

  if (job.kind === "fs_list") {
    const rel = typeof job.args.path === "string" ? job.args.path : ".";
    const target = resolveInJail(dataRoot, rel);
    if (!fs.existsSync(target)) throw new Error(`not_found: ${rel}`);
    const stat = fs.statSync(target);
    if (!stat.isDirectory()) throw new Error(`not_a_directory: ${rel}`);
    return {
      path: rel,
      entries: fs.readdirSync(target).map((name) => {
        const child = path.join(target, name);
        return {
          name,
          type: fs.statSync(child).isDirectory() ? ("dir" as const) : ("file" as const),
        };
      }),
    };
  }

  if (job.kind === "fs_ensure_dir") {
    const rel = strArg(job.args, "path");
    const target = resolveInJail(dataRoot, rel);
    fs.mkdirSync(target, { recursive: true });
    return { path: rel, ok: true };
  }

  if (job.kind === "fs_write_text") {
    const rel = strArg(job.args, "path");
    const content = typeof job.args.content === "string" ? job.args.content : "";
    const target = resolveInJail(dataRoot, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content, "utf8");
    return { path: rel, bytes: Buffer.byteLength(content, "utf8") };
  }

  const { docker, process: proc } = await ensureAdapters();

  if (job.kind === "container_create") {
    if (!docker) throw new Error("docker_unavailable");
    const name = strArg(job.args, "name");
    const image = strArg(job.args, "image");
    const env = (job.args.env as Record<string, string> | undefined) ?? {};
    const ports =
      (job.args.ports as Array<{
        host: number;
        container: number;
        protocol?: "tcp" | "udp";
      }>) ?? [];
    const binds =
      (job.args.binds as Array<{ hostPath: string; containerPath: string }>) ?? [];
    const resolvedBinds = binds.map((b) => ({
      hostPath: path.isAbsolute(b.hostPath) ? b.hostPath : resolveInJail(dataRoot, b.hostPath),
      containerPath: b.containerPath,
    }));
    for (const b of resolvedBinds) {
      fs.mkdirSync(b.hostPath, { recursive: true });
    }
    return docker.create({ name, image, env, ports, binds: resolvedBinds });
  }

  if (job.kind === "container_start") {
    if (!docker) throw new Error("docker_unavailable");
    await docker.start(strArg(job.args, "id"));
    return { ok: true };
  }

  if (job.kind === "container_stop") {
    if (!docker) throw new Error("docker_unavailable");
    await docker.stop(strArg(job.args, "id"));
    return { ok: true };
  }

  if (job.kind === "container_remove") {
    if (!docker) throw new Error("docker_unavailable");
    await docker.remove(strArg(job.args, "id"));
    return { ok: true };
  }

  if (job.kind === "container_inspect") {
    if (!docker) throw new Error("docker_unavailable");
    return docker.inspect(strArg(job.args, "id"));
  }

  if (job.kind === "container_logs") {
    if (!docker) throw new Error("docker_unavailable");
    const tail = typeof job.args.tail === "number" ? job.args.tail : 100;
    const lines = await docker.logs(strArg(job.args, "id"), tail);
    return { lines };
  }

  if (job.kind === "process_start") {
    const name = strArg(job.args, "name");
    const command = strArg(job.args, "command");
    const args = Array.isArray(job.args.args) ? (job.args.args as string[]) : [];
    const cwdRel = typeof job.args.cwd === "string" ? job.args.cwd : ".";
    const cwd = resolveInJail(dataRoot, cwdRel);
    const env = (job.args.env as Record<string, string> | undefined) ?? {};
    return proc.start({ name, command, args, cwd, env });
  }

  if (job.kind === "process_stop") {
    await proc.stop(strArg(job.args, "id"));
    return { ok: true };
  }

  if (job.kind === "process_status") {
    return proc.status(strArg(job.args, "id"));
  }

  if (job.kind === "steamcmd_app_update") {
    const serverRel = strArg(job.args, "serverRel");
    const serverDataPath = resolveInJail(dataRoot, serverRel);
    const appId = Number(job.args.appId);
    if (!Number.isFinite(appId)) throw new Error("invalid_appId");
    return steamcmdAppUpdate({
      serverDataPath,
      appId,
      installDirRel: typeof job.args.installDirRel === "string" ? job.args.installDirRel : undefined,
      validate: job.args.validate === true ? true : job.args.validate === false ? false : undefined,
    });
  }

  throw new Error(`unsupported_job_kind: ${String((job as { kind: string }).kind)}`);
}
