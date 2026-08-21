import crypto from "node:crypto";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ARCHIVE_EXTRACT_TIMEOUT_MS,
  WINDOWS_START_NODE_CMD,
  assertAllowedUpdateDownloadUrl,
  buildArchiveExtractCommands,
  bundledWindowsStartNodeCmd,
  startNodeCmdLoadsNodeEnv,
} from "@playon/shared";

/** Child exit that means "swap is on disk; relaunch me" — not a crash. */
export const AGENT_RELAUNCH_EXIT_CODE = 75;

export const AGENT_SUPERVISED_ENV = "PLAYON_AGENT_SUPERVISED";

export function isAgentSupervised(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[AGENT_SUPERVISED_ENV] === "1";
}

function copyTree(from: string, to: string): void {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name);
    const dest = path.join(to, entry.name);
    if (entry.isSymbolicLink()) {
      const link = fs.readlinkSync(src);
      try {
        fs.symlinkSync(link, dest);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "EEXIST") {
          fs.rmSync(dest, { recursive: true, force: true });
          fs.symlinkSync(link, dest);
        } else {
          throw err;
        }
      }
    } else if (entry.isDirectory()) {
      copyTree(src, dest);
    } else {
      fs.copyFileSync(src, dest);
    }
  }
}

export function swapInstallTree(opts: {
  target: string;
  source: string;
  preserve: string[];
}): { preserved: string[] } {
  const target = path.resolve(opts.target);
  const source = path.resolve(opts.source);
  const preserve = new Set(opts.preserve);
  if (!fs.existsSync(source)) throw new Error(`update_source_missing: ${source}`);
  fs.mkdirSync(target, { recursive: true });
  const preserved: string[] = [];
  const sourceNames = new Set(fs.readdirSync(source));
  for (const name of fs.readdirSync(target)) {
    if (preserve.has(name)) {
      if (fs.existsSync(path.join(target, name))) preserved.push(name);
      continue;
    }
    if (!sourceNames.has(name)) {
      fs.rmSync(path.join(target, name), { recursive: true, force: true });
    }
  }
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const name = entry.name;
    const dest = path.join(target, name);
    if (preserve.has(name) && fs.existsSync(dest)) continue;
    fs.rmSync(dest, { recursive: true, force: true });
    const src = path.join(source, name);
    if (entry.isDirectory()) copyTree(src, dest);
    else fs.copyFileSync(src, dest);
  }
  return { preserved };
}

/**
 * After a tree swap, restore Home wiring if the tarball's start-node.cmd
 * omitted `call node.env.cmd` (0.2.3–0.2.9 package-node.mjs).
 */
export function ensureWindowsStartNodeCmd(installRoot: string): { repaired: boolean } {
  const dest = path.join(installRoot, WINDOWS_START_NODE_CMD);
  const current = fs.existsSync(dest) ? fs.readFileSync(dest, "utf8") : "";
  if (startNodeCmdLoadsNodeEnv(current)) return { repaired: false };
  fs.writeFileSync(dest, bundledWindowsStartNodeCmd(), "utf8");
  return { repaired: true };
}

/** Extract apply: swap the package tree, then keep start-node.cmd pointing at Home. */
export function applyNodeInstallSwap(opts: {
  target: string;
  source: string;
  preserve: string[];
}): { preserved: string[]; startNodeRepaired: boolean } {
  const { preserved } = swapInstallTree(opts);
  const { repaired } = ensureWindowsStartNodeCmd(opts.target);
  return { preserved, startNodeRepaired: repaired };
}

/** Async extract so heartbeats keep ticking; never spawnSync powershell with a 60s cap (#868). */
export function runExtractCommand(
  cmd: string,
  args: readonly string[],
  timeoutMs: number = ARCHIVE_EXTRACT_TIMEOUT_MS,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
      if (stderr.length > 4000) stderr = stderr.slice(-4000);
    });
    const finish = (err?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) reject(err);
      else resolve();
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(new Error(`update_extract_timeout: ${cmd} exceeded ${timeoutMs}ms`));
    }, timeoutMs);
    child.once("error", (err) => {
      finish(err);
    });
    child.once("close", (code) => {
      if (code === 0) {
        finish();
        return;
      }
      const detail = stderr.trim().slice(0, 400);
      finish(
        new Error(
          detail
            ? `update_extract_failed: ${cmd} exit ${code}: ${detail}`
            : `update_extract_failed: ${cmd} exit ${code}`,
        ),
      );
    });
  });
}

export async function extractArchive(archivePath: string, destDir: string): Promise<string> {
  fs.rmSync(destDir, { recursive: true, force: true });
  fs.mkdirSync(destDir, { recursive: true });
  const commands = buildArchiveExtractCommands(archivePath, destDir, process.platform);
  let lastErr: Error | undefined;
  for (const { cmd, args } of commands) {
    try {
      await runExtractCommand(cmd, args, ARCHIVE_EXTRACT_TIMEOUT_MS);
      lastErr = undefined;
      break;
    } catch (err) {
      lastErr = err instanceof Error ? err : new Error(String(err));
    }
  }
  if (lastErr) throw lastErr;
  for (const name of ["playon-node", "playon"]) {
    const candidate = path.join(destDir, name);
    if (fs.existsSync(path.join(candidate, "package.json"))) return candidate;
  }
  for (const ent of fs.readdirSync(destDir, { withFileTypes: true })) {
    if (!ent.isDirectory()) continue;
    const candidate = path.join(destDir, ent.name);
    if (fs.existsSync(path.join(candidate, "package.json"))) return candidate;
  }
  throw new Error("update_extract_root_missing");
}

export function requireWindowsUpdateHelper(extracted: string): string {
  const helperScript = path.join(extracted, "deploy", "windows", "apply-self-update.ps1");
  if (!fs.existsSync(helperScript)) {
    throw new Error(
      "update_helper_missing: deploy/windows/apply-self-update.ps1 not found in release package",
    );
  }
  return helperScript;
}

export async function performNodeSelfUpdate(args: {
  downloadUrl: string;
  sha256: string;
  version: string;
  preserve?: string[];
  installRoot?: string;
  /** When true (tests), do not schedule process.exit */
  skipExit?: boolean;
}): Promise<{
  version: string;
  installRoot: string;
  preserved: string[];
  restartRequired: boolean;
}> {
  assertAllowedUpdateDownloadUrl(args.downloadUrl);
  const installRoot = path.resolve(
    args.installRoot || process.env.PLAYON_INSTALL_ROOT || process.cwd(),
  );
  const preserve =
    args.preserve ?? ["data", "env", "node.env", "node.env.cmd"];

  const staging = fs.mkdtempSync(path.join(os.tmpdir(), "playon-node-update-"));
  let windowsHelperSpawned = false;
  try {
    const archivePath = path.join(
      staging,
      path.basename(new URL(args.downloadUrl).pathname) || "node-update.bin",
    );
    const res = await fetch(args.downloadUrl, {
      headers: { accept: "application/octet-stream,*/*", "user-agent": "PlayOn-Node" },
    });
    if (!res.ok) throw new Error(`update_download_failed: ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    const sha256 = crypto.createHash("sha256").update(buf).digest("hex");
    if (sha256.toLowerCase() !== args.sha256.toLowerCase()) {
      throw new Error(`update_sha256_mismatch: expected ${args.sha256} got ${sha256}`);
    }
    fs.writeFileSync(archivePath, buf);
    const extracted = await extractArchive(archivePath, path.join(staging, "extracted"));

    if (process.platform === "win32" && !args.skipExit) {
      const result = performWindowsSelfUpdate({
        installRoot,
        extracted,
        preserve,
        version: args.version,
      });
      windowsHelperSpawned = true;
      return result;
    }

    const { preserved } = applyNodeInstallSwap({
      target: installRoot,
      source: extracted,
      preserve,
    });

    return {
      version: args.version,
      installRoot,
      preserved,
      restartRequired: args.skipExit ? false : true,
    };
  } finally {
    if (process.platform !== "win32" || args.skipExit || !windowsHelperSpawned) {
      fs.rmSync(staging, { recursive: true, force: true });
    }
  }
}

/** 0.2.3/0.2.4 used CommonJS require of node:child_process here and threw in ESM (#885). */
function performWindowsSelfUpdate(opts: {
  installRoot: string;
  extracted: string;
  preserve: string[];
  version: string;
}): {
  version: string;
  installRoot: string;
  preserved: string[];
  restartRequired: boolean;
} {
  const helperScript = requireWindowsUpdateHelper(opts.extracted);

  const preserveArgs = opts.preserve.flatMap((name) => ["-Preserve", name]);
  const args = [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    helperScript,
    "-SourceDir",
    opts.extracted,
    "-TargetDir",
    opts.installRoot,
    "-AgentPid",
    String(process.pid),
    ...preserveArgs,
  ];

  const child = spawn("powershell.exe", args, {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();

  return {
    version: opts.version,
    installRoot: opts.installRoot,
    preserved: opts.preserve,
    restartRequired: true,
  };
}

export function resolveAgentEntry(installRoot: string): string {
  const swapped = path.join(installRoot, "apps", "node-agent", "dist", "index.js");
  if (fs.existsSync(swapped)) return swapped;
  return process.argv[1] || swapped;
}

/** True when systemd started this process (`Restart=always` will replace us). */
export function isSystemdService(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.INVOCATION_ID) || env.PLAYON_AGENT_EXIT_MAINPID === "1";
}

/** Test / unit-file override. Prefer this over `systemctl show` in helpers. */
export const AGENT_KILL_MODE_ENV = "PLAYON_AGENT_KILL_MODE";

/**
 * systemd KillMode for the unit that owns `pid`. `control-group` (the default)
 * SIGTERMs leftover cgroup members on MAINPID exit + Restart=always.
 * `process` only signals MAINPID — games and the FIFO holder stay up.
 *
 * #888 assumed existing hosts already had `KillMode=process`. OTA never
 * rewrites `/etc/systemd`, so this must be read, not assumed (#909).
 */
export function readSystemdKillMode(
  env: NodeJS.ProcessEnv = process.env,
  pid: number = process.pid,
): string | null {
  const override = env[AGENT_KILL_MODE_ENV]?.trim();
  if (override) return override;
  if (process.platform === "win32") return null;
  try {
    const out = execFileSync("systemctl", ["show", String(pid), "-p", "KillMode", "--value"], {
      encoding: "utf8",
      timeout: 2_000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return out || null;
  } catch {
    return null;
  }
}

/**
 * Only exit systemd MAINPID when leftover cgroup members will not be
 * signaled and keepStdin consoles will not see pipe EOF.
 * Unknown KillMode is unsafe — keep MAINPID and supervisor-loop.
 */
export function shouldExitSystemdMainPid(opts: {
  killMode: string | null | undefined;
  hasPipeStdin?: boolean;
}): boolean {
  if (opts.hasPipeStdin) return false;
  return opts.killMode === "process";
}

/**
 * After a Linux swap, exit MAINPID only when systemd `KillMode=process` and
 * no pipe-based `keepStdin` child is still attached. Otherwise become a
 * supervisor: MAINPID stays, so `Restart=always` does not tear down the
 * cgroup (`control-group` units OTA cannot rewrite) and a pre-FIFO pipe
 * does not EOF (#909 / NZL 0.2.9→0.2.10).
 *
 * Native FIFO `keepStdin` children survive a *safe* MAINPID exit because a
 * holder keeps the write end open and they are in their own pgrp.
 * Moving them out of the agent cgroup is best-effort.
 *
 * A supervised child exits 75 so `runAgentSupervisorLoop` relaunches it.
 * Without systemd (`pnpm dev`) the same PID becomes that supervisor.
 * Windows exits so apply-self-update.ps1 can swap.
 */
export function relaunchUpdatedAgent(opts: {
  installRoot: string;
  skipExit?: boolean;
  /** Tests: do not take over this process. */
  spawnOnly?: boolean;
  /**
   * A running native child still has a Node pipe write-end (FIFO missing).
   * Exit would EOF Project Zomboid / other stdin consoles.
   */
  hasPipeStdin?: boolean;
}): ChildProcess | void {
  if (opts.skipExit) return;
  if (process.platform === "win32") {
    setTimeout(() => process.exit(0), 200);
    return;
  }
  if (isAgentSupervised()) {
    setTimeout(() => process.exit(AGENT_RELAUNCH_EXIT_CODE), 200);
    return;
  }
  if (
    isSystemdService() &&
    shouldExitSystemdMainPid({
      killMode: readSystemdKillMode(),
      hasPipeStdin: opts.hasPipeStdin,
    })
  ) {
    setTimeout(() => process.exit(0), 200);
    return;
  }
  const entry = resolveAgentEntry(opts.installRoot);
  return runAgentSupervisorLoop({
    nodeBin: process.execPath,
    argv: [entry],
    env: process.env,
    spawnOnly: opts.spawnOnly,
  });
}

export function runAgentSupervisorLoop(opts: {
  nodeBin: string;
  argv: string[];
  env?: NodeJS.ProcessEnv;
  spawnOnly?: boolean;
  /** Tests: relaunch on 75 but do not exit the test runner. */
  exitProcess?: boolean;
  onSpawn?: (child: ChildProcess) => void;
}): ChildProcess {
  const env = { ...opts.env, [AGENT_SUPERVISED_ENV]: "1" };
  const spawnChild = (): ChildProcess => {
    const next = spawn(opts.nodeBin, opts.argv, {
      stdio: "inherit",
      env,
      detached: false,
    });
    opts.onSpawn?.(next);
    return next;
  };

  const child = spawnChild();
  if (opts.spawnOnly) return child;

  const loop = (current: ChildProcess) => {
    current.once("exit", (code, signal) => {
      if (code === AGENT_RELAUNCH_EXIT_CODE) {
        loop(spawnChild());
        return;
      }
      if (opts.exitProcess === false) return;
      process.exit(code ?? (signal ? 1 : 0));
    });
  };
  loop(child);
  return child;
}
