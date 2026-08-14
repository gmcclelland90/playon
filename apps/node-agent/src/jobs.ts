import { execFile, execFileSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
import {
  createRuntime,
  resolveInJail,
  steamcmdAppUpdate,
  probeUdpListen,
  type DockerAdapter,
  type ProcessSupervisor,
} from "@playon/runtime";
import {
  FS_READ_MAX_BYTES,
  MANAGE_PACK_STAGING_REL,
  NodeJobError,
  parseNodeJobArgs,
  parseNodeJobResult,
  type NodeJobKind,
} from "@playon/shared";
import { assertPackPathAllowed, runImportProbe } from "./import-probe.js";
import { runManageCutover } from "./manage-cutover.js";
import { probeCapabilitiesForHeartbeat } from "./capabilities.js";
import { executeWslEnsureJob } from "./wsl-ensure.js";
import {
  beginContainerLogFollow,
  beginFileLogFollow,
  stopLogFollow,
} from "./log-follow.js";
import { performNodeSelfUpdate } from "./self-update.js";

/** TCP connect on this node. Used for the #843 loopback leg — not a remote scan. */
function probeTcpConnect(host: string, port: number, timeoutMs = 1500): Promise<"open" | "closed"> {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const done = (result: "open" | "closed") => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => done("open"));
    socket.once("timeout", () => done("closed"));
    socket.once("error", () => done("closed"));
  });
}

function managePackStagingDir(dataRoot: string): string {
  const dir = path.join(dataRoot, ...MANAGE_PACK_STAGING_REL.split("/"));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function freeBytesFor(dir: string): number | null {
  try {
    const statfs = (
      fs as typeof fs & {
        statfsSync?: (p: string) => { bavail: bigint | number; bsize: bigint | number };
      }
    ).statfsSync;
    if (typeof statfs === "function") {
      const s = statfs(dir);
      return Number(s.bavail) * Number(s.bsize);
    }
  } catch {
    /* fall through */
  }
  try {
    const out = execFileSync("df", ["-Pk", dir], { encoding: "utf8" });
    const line = out.trim().split("\n")[1];
    const availK = Number(line?.trim().split(/\s+/)[3]);
    if (Number.isFinite(availK)) return availK * 1024;
  } catch {
    /* ignore */
  }
  return null;
}

function approxDirBytes(dir: string): number {
  try {
    const out = execFileSync("du", ["-sb", dir], { encoding: "utf8" });
    const n = Number(out.trim().split(/\s+/)[0]);
    if (Number.isFinite(n) && n > 0) return n;
  } catch {
    /* Windows / missing du — walk */
  }
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

export type RemoteJobKind = NodeJobKind;

/**
 * Job kinds this agent can execute, advertised on every heartbeat so the control
 * plane can refuse kinds a skewed agent would not understand. Support here means
 * "there is a handler"; a handler may still fail at runtime when the host lacks a
 * dependency (e.g. `container_*` without Docker).
 *
 * Kept as an explicit list, not derived from the shared enum: adding a kind to the
 * protocol must be a deliberate decision on this shore too (see `jobs.test.ts`).
 */
export const SUPPORTED_JOB_KINDS: readonly NodeJobKind[] = [
  "ping",
  "runtime_caps",
  "net_udp_listen",
  "net_tcp_connect",
  "node_self_update",
  "fs_list",
  "fs_ensure_dir",
  "fs_write_text",
  "fs_read_text",
  "fs_put_archive",
  "fs_get_archive",
  "fs_remove",
  "fs_rename",
  "fs_copy",
  "container_create",
  "container_start",
  "container_stop",
  "container_remove",
  "container_inspect",
  "container_logs",
  "container_stdin",
  "process_start",
  "process_stop",
  "process_status",
  "steamcmd_app_update",
  "manage_probe",
  "manage_pack",
  "manage_pack_read",
  "manage_seed",
  "manage_cutover",
  "wsl_ensure",
];

const SUPPORTED_JOB_KIND_SET: ReadonlySet<string> = new Set(SUPPORTED_JOB_KINDS);

export interface RemoteJob {
  id: string;
  nodeId: string;
  kind: RemoteJobKind;
  args: Record<string, unknown>;
}

let dockerAdapter: DockerAdapter | null = null;
let processSupervisor: ProcessSupervisor | null = null;

/**
 * Windows install defaults to PLAYON_RUNTIME=native (PE / SteamCMD). A Windows
 * container engine on the same host must still be usable — Linux SteamCMD-only
 * hosts that force native stay native-only.
 */
export function shouldTryDockerAdapter(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (env.PLAYON_RUNTIME === "native" && platform !== "win32") return false;
  return true;
}

async function ensureAdapters(): Promise<{
  docker: DockerAdapter | null;
  process: ProcessSupervisor;
}> {
  if (processSupervisor) {
    return { docker: dockerAdapter, process: processSupervisor };
  }
  if (shouldTryDockerAdapter()) {
    try {
      const adapters = await createRuntime("docker");
      dockerAdapter = adapters.docker;
      processSupervisor = adapters.process;
      return { docker: dockerAdapter, process: processSupervisor };
    } catch {
      /* fall through to native */
    }
  }
  const adapters = await createRuntime("native");
  dockerAdapter = null;
  processSupervisor = adapters.process;
  return { docker: dockerAdapter, process: processSupervisor };
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

export async function reportJobProgress(
  apiBase: string,
  nodeId: string,
  jobId: string,
  message: string,
  token?: string,
): Promise<void> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token?.trim()) headers.authorization = `Bearer ${token.trim()}`;
  const res = await fetch(
    `${apiBase.replace(/\/$/, "")}/api/nodes/${encodeURIComponent(nodeId)}/jobs/${encodeURIComponent(jobId)}/progress`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({ message }),
    },
  );
  if (!res.ok) {
    // Progress is best-effort — do not fail the job if Home is briefly unreachable.
    console.warn(`[node-agent] job progress failed: ${res.status}`);
  }
}

export type ExecuteJobContext = {
  onProgress?: (message: string) => void | Promise<void>;
};

/**
 * Execute a claimed job locally with path jail under dataRoot.
 *
 * Every kind is validated on receive and again before the result is reported, so
 * a control plane on another version fails loudly instead of half-executing.
 */
export async function executeJob(
  job: RemoteJob,
  dataRoot: string,
  ctx: ExecuteJobContext = {},
): Promise<unknown> {
  if (!SUPPORTED_JOB_KIND_SET.has(job.kind)) {
    throw new NodeJobError("unsupported_job_kind", {
      kind: String((job as { kind: string }).kind),
    });
  }

  if (job.kind === "ping") {
    parseNodeJobArgs("ping", job.args);
    return parseNodeJobResult("ping", {
      pong: true,
      nodeId: job.nodeId,
      dataRoot,
      at: new Date().toISOString(),
    });
  }

  if (job.kind === "runtime_caps") {
    parseNodeJobArgs("runtime_caps", job.args);
    return parseNodeJobResult("runtime_caps", {
      ...(await probeCapabilitiesForHeartbeat(dataRoot)),
      jobKinds: [...SUPPORTED_JOB_KINDS],
    });
  }

  if (job.kind === "net_udp_listen") {
    const { port } = parseNodeJobArgs("net_udp_listen", job.args);
    return parseNodeJobResult("net_udp_listen", probeUdpListen(port));
  }

  if (job.kind === "net_tcp_connect") {
    const { host, port } = parseNodeJobArgs("net_tcp_connect", job.args);
    const state = await probeTcpConnect(host, port);
    return parseNodeJobResult("net_tcp_connect", { host, port, state });
  }

  if (job.kind === "node_self_update") {
    const args = parseNodeJobArgs("node_self_update", job.args);
    return parseNodeJobResult("node_self_update", await performNodeSelfUpdate(args));
  }

  if (job.kind === "fs_list") {
    const { path: rel } = parseNodeJobArgs("fs_list", job.args);
    const target = resolveInJail(dataRoot, rel);
    if (!fs.existsSync(target)) throw new Error(`not_found: ${rel}`);
    const stat = fs.statSync(target);
    if (!stat.isDirectory()) throw new Error(`not_a_directory: ${rel}`);
    return parseNodeJobResult("fs_list", {
      path: rel,
      entries: fs.readdirSync(target).map((name) => {
        const child = path.join(target, name);
        return {
          name,
          type: fs.statSync(child).isDirectory() ? ("dir" as const) : ("file" as const),
        };
      }),
    });
  }

  if (job.kind === "fs_ensure_dir") {
    const { path: rel } = parseNodeJobArgs("fs_ensure_dir", job.args);
    const target = resolveInJail(dataRoot, rel);
    fs.mkdirSync(target, { recursive: true });
    return parseNodeJobResult("fs_ensure_dir", { path: rel, ok: true });
  }

  if (job.kind === "fs_write_text") {
    const { path: rel, content } = parseNodeJobArgs("fs_write_text", job.args);
    const target = resolveInJail(dataRoot, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content, "utf8");
    return parseNodeJobResult("fs_write_text", {
      path: rel,
      bytes: Buffer.byteLength(content, "utf8"),
    });
  }

  if (job.kind === "fs_put_archive") {
    const { path: rel, archiveBase64 } = parseNodeJobArgs("fs_put_archive", job.args);
    const target = resolveInJail(dataRoot, rel);
    fs.rmSync(target, { recursive: true, force: true });
    fs.mkdirSync(target, { recursive: true });
    if (archiveBase64) {
      const staging = fs.mkdtempSync(path.join(os.tmpdir(), "playon-node-put-"));
      const archive = path.join(staging, "tree.tar");
      try {
        fs.writeFileSync(archive, Buffer.from(archiveBase64, "base64"));
        execFileSync("tar", ["-xf", archive, "-C", target], { stdio: "pipe" });
      } finally {
        fs.rmSync(staging, { recursive: true, force: true });
      }
    }
    return parseNodeJobResult("fs_put_archive", { path: rel, ok: true });
  }

  if (job.kind === "fs_get_archive") {
    const { path: rel } = parseNodeJobArgs("fs_get_archive", job.args);
    const target = resolveInJail(dataRoot, rel);
    if (!fs.existsSync(target)) {
      return parseNodeJobResult("fs_get_archive", { archiveBase64: "" });
    }
    const staging = fs.mkdtempSync(path.join(os.tmpdir(), "playon-node-get-"));
    const archive = path.join(staging, "tree.tar");
    try {
      execFileSync("tar", ["-cf", archive, "-C", target, "."], { stdio: "pipe" });
      return parseNodeJobResult("fs_get_archive", {
        archiveBase64: fs.readFileSync(archive).toString("base64"),
      });
    } finally {
      fs.rmSync(staging, { recursive: true, force: true });
    }
  }

  if (job.kind === "fs_remove") {
    const { path: rel } = parseNodeJobArgs("fs_remove", job.args);
    const target = resolveInJail(dataRoot, rel);
    fs.rmSync(target, { recursive: true, force: true });
    return parseNodeJobResult("fs_remove", { path: rel, ok: true });
  }

  if (job.kind === "fs_read_text") {
    const { path: rel, offset, maxBytes } = parseNodeJobArgs("fs_read_text", job.args);
    const target = resolveInJail(dataRoot, rel);
    if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
      throw new Error(`not_found: ${rel}`);
    }
    const size = fs.statSync(target).size;
    // The cap is ours, not the caller's: oversized asks are clamped, not refused.
    const capped = Math.min(FS_READ_MAX_BYTES, maxBytes ?? FS_READ_MAX_BYTES);
    if (offset > size) {
      return parseNodeJobResult("fs_read_text", {
        path: rel,
        content: "",
        bytesRead: 0,
        truncated: false,
        size,
      });
    }
    const fd = fs.openSync(target, "r");
    try {
      const length = Math.min(capped, size - offset);
      const buf = Buffer.alloc(length);
      const bytesRead = fs.readSync(fd, buf, 0, length, offset);
      return parseNodeJobResult("fs_read_text", {
        path: rel,
        content: buf.subarray(0, bytesRead).toString("utf8"),
        bytesRead,
        truncated: offset + bytesRead < size,
        size,
      });
    } finally {
      fs.closeSync(fd);
    }
  }

  if (job.kind === "fs_rename") {
    const { from: fromRel, to: toRel, overwrite } = parseNodeJobArgs("fs_rename", job.args);
    const from = resolveInJail(dataRoot, fromRel);
    const to = resolveInJail(dataRoot, toRel);
    if (!fs.existsSync(from)) throw new Error(`not_found: ${fromRel}`);
    if (fs.existsSync(to) && !overwrite) throw new Error(`already_exists: ${toRel}`);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    if (fs.existsSync(to) && overwrite) {
      fs.rmSync(to, { recursive: true, force: true });
    }
    fs.renameSync(from, to);
    return parseNodeJobResult("fs_rename", { from: fromRel, to: toRel });
  }

  if (job.kind === "fs_copy") {
    const { from: fromRel, to: toRel, overwrite } = parseNodeJobArgs("fs_copy", job.args);
    const from = resolveInJail(dataRoot, fromRel);
    const to = resolveInJail(dataRoot, toRel);
    if (!fs.existsSync(from)) throw new Error(`not_found: ${fromRel}`);
    if (fs.existsSync(to) && !overwrite) throw new Error(`already_exists: ${toRel}`);
    if (fs.existsSync(to) && overwrite) {
      fs.rmSync(to, { recursive: true, force: true });
    }
    const copyRecursive = (src: string, dest: string): void => {
      const stat = fs.statSync(src);
      if (stat.isDirectory()) {
        fs.mkdirSync(dest, { recursive: true });
        for (const name of fs.readdirSync(src)) {
          copyRecursive(path.join(src, name), path.join(dest, name));
        }
        return;
      }
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(src, dest);
    };
    copyRecursive(from, to);
    return parseNodeJobResult("fs_copy", { from: fromRel, to: toRel });
  }

  const { docker, process: proc } = await ensureAdapters();

  if (job.kind === "container_create") {
    const { name, image, env, cmd, ports, binds, tty, isolation } = parseNodeJobArgs(
      "container_create",
      job.args,
    );
    if (!docker) throw new Error("docker_unavailable");
    // An absolute hostPath is a deliberate escape hatch for host-owned mounts;
    // anything relative resolves inside the jail.
    const resolvedBinds = binds.map((b) => ({
      hostPath: path.isAbsolute(b.hostPath) ? b.hostPath : resolveInJail(dataRoot, b.hostPath),
      containerPath: b.containerPath,
    }));
    for (const b of resolvedBinds) {
      fs.mkdirSync(b.hostPath, { recursive: true });
    }
    return parseNodeJobResult(
      "container_create",
      await docker.create({
        name,
        image,
        env,
        ...(cmd.length ? { cmd } : {}),
        ports,
        binds: resolvedBinds,
        ...(tty != null ? { tty } : {}),
        ...(isolation ? { isolation } : {}),
      }),
    );
  }

  if (job.kind === "container_start") {
    const { id, serverId } = parseNodeJobArgs("container_start", job.args);
    if (!docker) throw new Error("docker_unavailable");
    await docker.start(id);
    if (serverId) {
      await beginContainerLogFollow(serverId, docker, id).catch((err) => {
        console.warn(
          `[node-agent] container log follow failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      });
    }
    return parseNodeJobResult("container_start", { ok: true });
  }

  if (job.kind === "container_stop") {
    const { id, serverId } = parseNodeJobArgs("container_stop", job.args);
    if (!docker) throw new Error("docker_unavailable");
    if (serverId) stopLogFollow(serverId);
    await docker.stop(id);
    return parseNodeJobResult("container_stop", { ok: true });
  }

  if (job.kind === "container_remove") {
    const { id } = parseNodeJobArgs("container_remove", job.args);
    if (!docker) throw new Error("docker_unavailable");
    await docker.remove(id);
    return parseNodeJobResult("container_remove", { ok: true });
  }

  if (job.kind === "container_inspect") {
    const { id } = parseNodeJobArgs("container_inspect", job.args);
    if (!docker) throw new Error("docker_unavailable");
    return parseNodeJobResult("container_inspect", await docker.inspect(id));
  }

  if (job.kind === "container_logs") {
    const { id, tail } = parseNodeJobArgs("container_logs", job.args);
    if (!docker) throw new Error("docker_unavailable");
    return parseNodeJobResult("container_logs", { lines: await docker.logs(id, tail) });
  }

  if (job.kind === "container_stdin") {
    const { id, line } = parseNodeJobArgs("container_stdin", job.args);
    if (!docker) throw new Error("docker_unavailable");
    if (typeof docker.writeStdin !== "function") {
      throw new Error("container_stdin_unsupported");
    }
    await docker.writeStdin(id, line);
    return parseNodeJobResult("container_stdin", { ok: true });
  }

  if (job.kind === "process_start") {
    const {
      name,
      command,
      args,
      cwd: cwdRel,
      env,
      serverId,
      logRel,
      keepStdin,
    } = parseNodeJobArgs("process_start", job.args);
    const cwd = resolveInJail(dataRoot, cwdRel);
    const logFile = logRel ? resolveInJail(dataRoot, logRel) : undefined;
    const info = await proc.start({ name, command, args, cwd, env, logFile, keepStdin });
    if (serverId && logFile) {
      beginFileLogFollow(serverId, logFile);
    }
    return parseNodeJobResult("process_start", info);
  }

  if (job.kind === "process_stop") {
    const { id, name, cwd: cwdRel, serverId } = parseNodeJobArgs("process_stop", job.args);
    if (serverId) stopLogFollow(serverId);
    if (id) {
      await proc.stop(id).catch(() => undefined);
    }
    // Always reclaim by cwd/name so stop works after node-agent restart (lost map).
    if (cwdRel && typeof proc.reclaim === "function") {
      const cwd = resolveInJail(dataRoot, cwdRel);
      await proc.reclaim(name || `server-unknown`, cwd);
    }
    return parseNodeJobResult("process_stop", { ok: true });
  }

  if (job.kind === "process_status") {
    const { id, name, cwd: cwdRel } = parseNodeJobArgs("process_status", job.args);
    if (id) {
      return parseNodeJobResult("process_status", await proc.status(id));
    }
    // No id to look up: re-resolve from identity, which also sees OS orphans a
    // restart on either shore would otherwise hide.
    const found = await proc.find(name!, resolveInJail(dataRoot, cwdRel!));
    return parseNodeJobResult(
      "process_status",
      found ?? { id: name!, name: name!, status: "stopped" },
    );
  }

  if (job.kind === "steamcmd_app_update") {
    const { serverRel, appId, installDirRel, validate, steamMod, steamBetaLinux } =
      parseNodeJobArgs("steamcmd_app_update", job.args);
    return parseNodeJobResult(
      "steamcmd_app_update",
      await steamcmdAppUpdate({
        serverDataPath: resolveInJail(dataRoot, serverRel),
        appId,
        installDirRel,
        validate,
        steamMod,
        steamBetaLinux,
      }),
    );
  }

  if (job.kind === "manage_probe") {
    const args = parseNodeJobArgs("manage_probe", job.args);
    return parseNodeJobResult("manage_probe", runImportProbe(args));
  }

  if (job.kind === "manage_pack") {
    const args = parseNodeJobArgs("manage_pack", job.args);
    const target = assertPackPathAllowed(args.path, args.allowRoots);
    // Stage on the data disk — never /tmp (often a small tmpfs).
    const packsDir = managePackStagingDir(dataRoot);
    const sourceBytes = approxDirBytes(target);
    const free = freeBytesFor(packsDir);
    if (sourceBytes > 0 && free != null && free < sourceBytes + 64 * 1024 * 1024) {
      throw new Error(
        `not_enough_disk: need ~${sourceBytes} bytes free under ${packsDir}, have ${free}`,
      );
    }
    const archive = path.join(packsDir, `pack-${job.id}.tar`);
    try {
      if (fs.existsSync(archive)) fs.rmSync(archive, { force: true });
      execFileSync("tar", ["-cf", archive, "-C", target, "."], { stdio: "pipe" });
      const st = fs.statSync(archive);
      if (st.size > args.maxBytes) {
        fs.rmSync(archive, { force: true });
        throw new Error(`archive_too_large: ${st.size} bytes (max ${args.maxBytes})`);
      }
      return parseNodeJobResult("manage_pack", {
        packRel: path.relative(dataRoot, archive).split(path.sep).join("/"),
        bytes: st.size,
        path: target,
      });
    } catch (err) {
      fs.rmSync(archive, { force: true });
      throw err;
    }
  }

  if (job.kind === "manage_seed") {
    const args = parseNodeJobArgs("manage_seed", job.args);
    const source = assertPackPathAllowed(args.sourcePath, args.allowRoots);
    const dest = resolveInJail(dataRoot, args.destRel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.rmSync(dest, { recursive: true, force: true });
    fs.mkdirSync(dest, { recursive: true });
    // Async host copy so heartbeats keep ticking (fs.cpSync blocks the event loop).
    if (process.platform === "win32") {
      await new Promise<void>((resolve, reject) => {
        fs.cp(source, dest, { recursive: true }, (err) => (err ? reject(err) : resolve()));
      });
    } else {
      await execFileAsync("cp", ["-a", `${source}/.`, dest], {
        maxBuffer: 16 * 1024 * 1024,
      });
    }
    const bytesCopied = approxDirBytes(dest);
    return parseNodeJobResult("manage_seed", {
      destRel: args.destRel,
      sourcePath: source,
      bytesCopied,
    });
  }

  if (job.kind === "manage_pack_read") {
    // The contract already pins packRel under the staging dir; the jail is the backstop.
    const args = parseNodeJobArgs("manage_pack_read", job.args);
    const abs = resolveInJail(dataRoot, args.packRel);
    if (!fs.existsSync(abs)) throw new Error(`pack_not_found: ${args.packRel}`);
    const fd = fs.openSync(abs, "r");
    try {
      const buf = Buffer.alloc(args.length);
      const read = fs.readSync(fd, buf, 0, args.length, args.offset);
      const slice = buf.subarray(0, read);
      const st = fs.fstatSync(fd);
      const next = args.offset + read;
      return parseNodeJobResult("manage_pack_read", {
        dataBase64: slice.toString("base64"),
        bytes: read,
        offset: args.offset,
        done: next >= st.size,
      });
    } finally {
      fs.closeSync(fd);
    }
  }

  if (job.kind === "manage_cutover") {
    const args = parseNodeJobArgs("manage_cutover", job.args);
    return parseNodeJobResult("manage_cutover", await runManageCutover(args, dataRoot));
  }

  if (job.kind === "wsl_ensure") {
    return executeWslEnsureJob(job.args, ctx.onProgress);
  }

  throw new NodeJobError("unsupported_job_kind", {
    kind: String((job as { kind: string }).kind),
  });
}
