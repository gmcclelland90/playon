import { execFile, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
import {
  createRuntime,
  resolveInJail,
  steamcmdAppUpdate,
  type DockerAdapter,
  type ProcessSupervisor,
} from "@playon/runtime";
import {
  ImportPackArgsSchema,
  ImportProbeArgsSchema,
  ManageCutoverArgsSchema,
  ManagePackReadArgsSchema,
  ManageSeedArgsSchema,
  type NodeJobKind,
} from "@playon/shared";
import { assertPackPathAllowed, runImportProbe } from "./import-probe.js";
import { runManageCutover } from "./manage-cutover.js";
import { probeCapabilities } from "./capabilities.js";
import { performNodeSelfUpdate } from "./self-update.js";

function managePackStagingDir(dataRoot: string): string {
  const dir = path.join(dataRoot, "tmp", "manage-packs");
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

  if (job.kind === "fs_put_archive") {
    const rel = strArg(job.args, "path");
    const archiveBase64 = typeof job.args.archiveBase64 === "string" ? job.args.archiveBase64 : "";
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
    return { path: rel, ok: true };
  }

  if (job.kind === "fs_get_archive") {
    const rel = strArg(job.args, "path");
    const target = resolveInJail(dataRoot, rel);
    if (!fs.existsSync(target)) {
      return { archiveBase64: "" };
    }
    const staging = fs.mkdtempSync(path.join(os.tmpdir(), "playon-node-get-"));
    const archive = path.join(staging, "tree.tar");
    try {
      execFileSync("tar", ["-cf", archive, "-C", target, "."], { stdio: "pipe" });
      return { archiveBase64: fs.readFileSync(archive).toString("base64") };
    } finally {
      fs.rmSync(staging, { recursive: true, force: true });
    }
  }

  if (job.kind === "fs_remove") {
    const rel = strArg(job.args, "path");
    const target = resolveInJail(dataRoot, rel);
    fs.rmSync(target, { recursive: true, force: true });
    return { path: rel, ok: true };
  }

  if (job.kind === "fs_read_text") {
    const rel = strArg(job.args, "path");
    const target = resolveInJail(dataRoot, rel);
    if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
      throw new Error(`not_found: ${rel}`);
    }
    const size = fs.statSync(target).size;
    const offset = Math.max(0, Math.floor(Number(job.args.offset ?? 0) || 0));
    const maxCap = 512_000;
    const maxBytes = Math.min(
      maxCap,
      Math.max(1, Math.floor(Number(job.args.maxBytes ?? maxCap) || maxCap)),
    );
    if (offset > size) {
      return { path: rel, content: "", bytesRead: 0, truncated: false, size };
    }
    const fd = fs.openSync(target, "r");
    try {
      const length = Math.min(maxBytes, size - offset);
      const buf = Buffer.alloc(length);
      const bytesRead = fs.readSync(fd, buf, 0, length, offset);
      return {
        path: rel,
        content: buf.subarray(0, bytesRead).toString("utf8"),
        bytesRead,
        truncated: offset + bytesRead < size,
        size,
      };
    } finally {
      fs.closeSync(fd);
    }
  }

  if (job.kind === "fs_rename") {
    const fromRel = strArg(job.args, "from");
    const toRel = strArg(job.args, "to");
    const from = resolveInJail(dataRoot, fromRel);
    const to = resolveInJail(dataRoot, toRel);
    if (!fs.existsSync(from)) throw new Error(`not_found: ${fromRel}`);
    const overwrite = job.args.overwrite === true;
    if (fs.existsSync(to) && !overwrite) throw new Error(`already_exists: ${toRel}`);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    if (fs.existsSync(to) && overwrite) {
      fs.rmSync(to, { recursive: true, force: true });
    }
    fs.renameSync(from, to);
    return { from: fromRel, to: toRel };
  }

  if (job.kind === "fs_copy") {
    const fromRel = strArg(job.args, "from");
    const toRel = strArg(job.args, "to");
    const from = resolveInJail(dataRoot, fromRel);
    const to = resolveInJail(dataRoot, toRel);
    if (!fs.existsSync(from)) throw new Error(`not_found: ${fromRel}`);
    const overwrite = job.args.overwrite === true;
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
    return { from: fromRel, to: toRel };
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

  if (job.kind === "node_self_update") {
    const downloadUrl = strArg(job.args, "downloadUrl");
    const sha256 = strArg(job.args, "sha256");
    const version = strArg(job.args, "version");
    const preserve = Array.isArray(job.args.preserve)
      ? (job.args.preserve as string[])
      : undefined;
    return performNodeSelfUpdate({
      downloadUrl,
      sha256,
      version,
      preserve,
      skipExit: job.args.skipExit === true,
    });
  }

  if (job.kind === "manage_probe") {
    const args = ImportProbeArgsSchema.parse(job.args);
    return runImportProbe(args);
  }

  if (job.kind === "manage_pack") {
    const args = ImportPackArgsSchema.parse(job.args);
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
      return {
        packRel: path.relative(dataRoot, archive).split(path.sep).join("/"),
        bytes: st.size,
        path: target,
      };
    } catch (err) {
      fs.rmSync(archive, { force: true });
      throw err;
    }
  }

  if (job.kind === "manage_seed") {
    const args = ManageSeedArgsSchema.parse(job.args);
    const source = assertPackPathAllowed(args.sourcePath, args.allowRoots);
    if (args.destRel.includes("..") || path.isAbsolute(args.destRel)) {
      throw new Error("invalid_destRel");
    }
    if (!args.destRel.startsWith("servers/") || !args.destRel.endsWith("/game")) {
      throw new Error("destRel_must_be_servers_id_game");
    }
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
    return {
      destRel: args.destRel,
      sourcePath: source,
      bytesCopied,
    };
  }

  if (job.kind === "manage_pack_read") {
    const args = ManagePackReadArgsSchema.parse(job.args);
    if (args.packRel.includes("..") || path.isAbsolute(args.packRel)) {
      throw new Error("invalid_packRel");
    }
    const abs = resolveInJail(dataRoot, args.packRel);
    const packs = path.resolve(managePackStagingDir(dataRoot));
    if (!path.resolve(abs).startsWith(packs + path.sep)) {
      throw new Error("packRel_not_in_manage_packs");
    }
    if (!fs.existsSync(abs)) throw new Error(`pack_not_found: ${args.packRel}`);
    const fd = fs.openSync(abs, "r");
    try {
      const buf = Buffer.alloc(args.length);
      const read = fs.readSync(fd, buf, 0, args.length, args.offset);
      const slice = buf.subarray(0, read);
      const st = fs.fstatSync(fd);
      const next = args.offset + read;
      return {
        dataBase64: slice.toString("base64"),
        bytes: read,
        offset: args.offset,
        done: next >= st.size,
      };
    } finally {
      fs.closeSync(fd);
    }
  }

  if (job.kind === "manage_cutover") {
    const args = ManageCutoverArgsSchema.parse(job.args);
    return runManageCutover(args, dataRoot);
  }

  throw new Error(`unsupported_job_kind: ${String((job as { kind: string }).kind)}`);
}
