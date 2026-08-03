import { spawn } from "node:child_process";
import fs from "node:fs";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { resolveInJail } from "./path-jail.js";

export interface SteamcmdRunResult {
  ok: true;
  binary: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  installDir: string;
  appId: number;
  provisioned?: boolean;
}

const STEAMCMD_LINUX_URL =
  "https://steamcdn-a.akamaihd.net/client/installer/steamcmd_linux.tar.gz";
const STEAMCMD_WINDOWS_URL =
  "https://steamcdn-a.akamaihd.net/client/installer/steamcmd.zip";

function candidateBinaries(env: NodeJS.ProcessEnv = process.env): string[] {
  const fromEnv = [
    env.PLAYON_STEAMCMD?.trim(),
    env.STEAMCMD?.trim(),
    env.STEAMCMD_PATH?.trim(),
  ].filter(Boolean) as string[];

  const home = env.HOME?.trim() || env.USERPROFILE?.trim() || os.homedir();
  const extras =
    process.platform === "win32"
      ? [
          path.join(home, "SteamCMD", "steamcmd.exe"),
          path.join(home, "steamcmd", "steamcmd.exe"),
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

export function findSteamcmdBinary(env: NodeJS.ProcessEnv = process.env): string | null {
  for (const candidate of candidateBinaries(env)) {
    if (candidate && fs.existsSync(candidate)) return path.resolve(candidate);
  }

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
  constructor(detail?: string) {
    super(
      detail ??
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
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
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

function downloadFile(url: string, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    https
      .get(url, (res) => {
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          file.close();
          fs.unlinkSync(dest);
          downloadFile(res.headers.location, dest).then(resolve, reject);
          return;
        }
        if (res.statusCode !== 200) {
          file.close();
          fs.unlinkSync(dest);
          reject(new Error(`steamcmd_download_failed: HTTP ${res.statusCode}`));
          return;
        }
        res.pipe(file);
        file.on("finish", () => file.close(() => resolve()));
      })
      .on("error", (err) => {
        file.close();
        try {
          fs.unlinkSync(dest);
        } catch {
          /* ignore */
        }
        reject(err);
      });
  });
}

function defaultInstallRoot(env: NodeJS.ProcessEnv): string {
  const fromEnv = env.PLAYON_STEAMCMD_HOME?.trim();
  if (fromEnv) return path.resolve(fromEnv);
  const home = env.HOME?.trim() || env.USERPROFILE?.trim() || os.homedir();
  return path.join(home, "steamcmd");
}

export async function installSteamcmdLinux(opts?: {
  installRoot?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}): Promise<string> {
  if (process.platform === "win32") {
    throw new SteamcmdNotFoundError(
      "steamcmd_not_found: use installSteamcmdWindows on Windows hosts",
    );
  }
  const env = opts?.env ?? process.env;
  const installRoot = opts?.installRoot ?? defaultInstallRoot(env);
  fs.mkdirSync(installRoot, { recursive: true });
  const archive = path.join(installRoot, "steamcmd_linux.tar.gz");
  await downloadFile(STEAMCMD_LINUX_URL, archive);
  const extract = await runProcess("tar", ["-xzf", archive, "-C", installRoot], installRoot, 120_000, env);
  if (extract.exitCode !== 0) {
    throw new Error(`steamcmd_extract_failed: ${extract.stderr.slice(-300)}`);
  }
  try {
    fs.unlinkSync(archive);
  } catch {
    /* ignore */
  }
  const binary = path.join(installRoot, "steamcmd.sh");
  if (!fs.existsSync(binary)) {
    throw new Error(`steamcmd_install_failed: missing ${binary}`);
  }
  fs.chmodSync(binary, 0o755);
  await runProcess(binary, ["+quit"], installRoot, opts?.timeoutMs ?? 180_000, env).catch(() => undefined);
  if (!fs.existsSync(binary)) {
    throw new Error("steamcmd_install_failed: steamcmd.sh disappeared after bootstrap");
  }
  return path.resolve(binary);
}

/** Download + extract official Windows SteamCMD zip into installRoot. */
export async function installSteamcmdWindows(opts?: {
  installRoot?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}): Promise<string> {
  if (process.platform !== "win32") {
    throw new SteamcmdNotFoundError(
      "steamcmd_not_found: use installSteamcmdLinux on non-Windows hosts",
    );
  }
  const env = opts?.env ?? process.env;
  const installRoot = opts?.installRoot ?? defaultInstallRoot(env);
  fs.mkdirSync(installRoot, { recursive: true });
  const archive = path.join(installRoot, "steamcmd.zip");
  await downloadFile(STEAMCMD_WINDOWS_URL, archive);
  const extract = await runProcess(
    "powershell.exe",
    [
      "-NoProfile",
      "-Command",
      `Expand-Archive -Path '${archive.replace(/'/g, "''")}' -DestinationPath '${installRoot.replace(/'/g, "''")}' -Force`,
    ],
    installRoot,
    120_000,
    env,
  );
  if (extract.exitCode !== 0) {
    throw new Error(`steamcmd_extract_failed: ${extract.stderr.slice(-300)}`);
  }
  try {
    fs.unlinkSync(archive);
  } catch {
    /* ignore */
  }
  const binary = path.join(installRoot, "steamcmd.exe");
  if (!fs.existsSync(binary)) {
    throw new Error(`steamcmd_install_failed: missing ${binary}`);
  }
  await runProcess(binary, ["+quit"], installRoot, opts?.timeoutMs ?? 180_000, env).catch(() => undefined);
  if (!fs.existsSync(binary)) {
    throw new Error("steamcmd_install_failed: steamcmd.exe disappeared after bootstrap");
  }
  return path.resolve(binary);
}

function autoInstallEnabled(env: NodeJS.ProcessEnv): boolean {
  const raw = env.PLAYON_STEAMCMD_AUTO?.trim().toLowerCase();
  if (raw === "0" || raw === "false" || raw === "off" || raw === "no") return false;
  return true;
}

/** Find SteamCMD, or auto-download on Linux/Windows when allowed. */
export async function ensureSteamcmdBinary(opts?: {
  env?: NodeJS.ProcessEnv;
  autoInstall?: boolean;
  installRoot?: string;
}): Promise<{ binary: string; provisioned: boolean }> {
  const env = opts?.env ?? process.env;
  const existing = findSteamcmdBinary(env);
  if (existing) return { binary: existing, provisioned: false };

  const allowAuto = opts?.autoInstall ?? autoInstallEnabled(env);
  if (!allowAuto) {
    throw new SteamcmdNotFoundError();
  }

  const installRoot = opts?.installRoot ?? defaultInstallRoot(env);
  const binary =
    process.platform === "win32"
      ? await installSteamcmdWindows({ installRoot, env })
      : await installSteamcmdLinux({ installRoot, env });
  return { binary, provisioned: true };
}

export async function steamcmdAppUpdate(args: {
  serverDataPath: string;
  appId: number;
  installDirRel?: string;
  validate?: boolean;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  autoInstall?: boolean;
}): Promise<SteamcmdRunResult> {
  const env = args.env ?? process.env;
  const { binary, provisioned } = await ensureSteamcmdBinary({
    env,
    autoInstall: args.autoInstall,
  });

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
    env,
  );

  if (exitCode !== 0) {
    const detail = `steamcmd_failed: exit=${exitCode} appId=${args.appId} stderr=${stderr.slice(-400)}`;
    if (exitCode === 127) {
      throw new SteamcmdNotFoundError(detail);
    }
    throw new Error(detail);
  }

  return {
    ok: true,
    binary,
    exitCode,
    stdout: stdout.slice(-4_000),
    stderr: stderr.slice(-2_000),
    installDir,
    appId: args.appId,
    provisioned,
  };
}

export async function steamcmdProbe(
  env: NodeJS.ProcessEnv = process.env,
  timeoutMs = 60_000,
): Promise<{ ok: true; binary: string; exitCode: number; provisioned?: boolean }> {
  const { binary, provisioned } = await ensureSteamcmdBinary({ env });
  const { exitCode } = await runProcess(binary, ["+quit"], path.dirname(binary), timeoutMs, env);
  return { ok: true, binary, exitCode, provisioned };
}
