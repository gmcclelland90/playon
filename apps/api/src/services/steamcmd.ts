import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveInJail } from "@playon/runtime";

export interface SteamcmdRunResult {
  ok: true;
  binary: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  installDir: string;
  appId: number;
}

function candidateBinaries(env: NodeJS.ProcessEnv = process.env): string[] {
  const fromEnv = [
    env.PLAYON_STEAMCMD?.trim(),
    env.STEAMCMD?.trim(),
    env.STEAMCMD_PATH?.trim(),
  ].filter(Boolean) as string[];

  const home = os.homedir();
  const extras =
    process.platform === "win32"
      ? [
          path.join(home, "SteamCMD", "steamcmd.exe"),
          "C:\\SteamCMD\\steamcmd.exe",
          "C:\\steamcmd\\steamcmd.exe",
        ]
      : [
          path.join(home, "steamcmd", "steamcmd.sh"),
          "/usr/games/steamcmd",
          "/usr/bin/steamcmd",
          "/opt/steamcmd/steamcmd.sh",
        ];

  return [...fromEnv, ...extras];
}

/** Resolve a SteamCMD binary on this host, or null. */
export function findSteamcmdBinary(env: NodeJS.ProcessEnv = process.env): string | null {
  for (const candidate of candidateBinaries(env)) {
    if (candidate && fs.existsSync(candidate)) return path.resolve(candidate);
  }

  // PATH lookup (best-effort)
  const pathEnv = env.PATH ?? env.Path ?? "";
  const names =
    process.platform === "win32" ? ["steamcmd.exe", "steamcmd"] : ["steamcmd", "steamcmd.sh"];
  for (const dir of pathEnv.split(path.delimiter)) {
    if (!dir) continue;
    for (const name of names) {
      const full = path.join(dir, name);
      if (fs.existsSync(full)) return path.resolve(full);
    }
  }
  return null;
}

export class SteamcmdNotFoundError extends Error {
  readonly code = "steamcmd_not_found";
  constructor() {
    super(
      "steamcmd_not_found: install SteamCMD on this host (or set PLAYON_STEAMCMD to the binary path), then retry",
    );
    this.name = "SteamcmdNotFoundError";
  }
}

function runProcess(
  command: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: process.env,
      shell: false,
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`steamcmd_timeout: exceeded ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      if (stdout.length > 512_000) stdout = stdout.slice(-512_000);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
      if (stderr.length > 256_000) stderr = stderr.slice(-256_000);
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ exitCode: code ?? 1, stdout, stderr });
    });
  });
}

/**
 * Run SteamCMD `+app_update` into a jailed install directory under the server data path.
 * Fails loud with `steamcmd_not_found` when the binary is missing — never fakes success.
 */
export async function steamcmdAppUpdate(args: {
  serverDataPath: string;
  appId: number;
  /** Relative path under the server jail (default game/steamapps). */
  installDirRel?: string;
  validate?: boolean;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
}): Promise<SteamcmdRunResult> {
  const binary = findSteamcmdBinary(args.env);
  if (!binary) throw new SteamcmdNotFoundError();

  const installRel = args.installDirRel?.trim() || "game";
  const installDir = resolveInJail(args.serverDataPath, installRel);
  fs.mkdirSync(installDir, { recursive: true });

  const cmdArgs = [
    "+force_install_dir",
    installDir,
    "+login",
    "anonymous",
    "+app_update",
    String(args.appId),
  ];
  if (args.validate !== false) cmdArgs.push("validate");
  cmdArgs.push("+quit");

  const cwd = path.dirname(binary);
  const { exitCode, stdout, stderr } = await runProcess(
    binary,
    cmdArgs,
    cwd,
    args.timeoutMs ?? 600_000,
  );

  if (exitCode !== 0) {
    throw new Error(
      `steamcmd_failed: exit=${exitCode} appId=${args.appId} stderr=${stderr.slice(-400)}`,
    );
  }

  return {
    ok: true,
    binary,
    exitCode,
    stdout: stdout.slice(-4_000),
    stderr: stderr.slice(-2_000),
    installDir,
    appId: args.appId,
  };
}

/** Lightweight probe: run `+quit` only to prove the binary executes. */
export async function steamcmdProbe(
  env: NodeJS.ProcessEnv = process.env,
  timeoutMs = 60_000,
): Promise<{ ok: true; binary: string; exitCode: number }> {
  const binary = findSteamcmdBinary(env);
  if (!binary) throw new SteamcmdNotFoundError();
  const { exitCode } = await runProcess(binary, ["+quit"], path.dirname(binary), timeoutMs);
  return { ok: true, binary, exitCode };
}
