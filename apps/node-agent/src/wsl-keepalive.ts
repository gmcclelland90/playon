/**
 * Keep the PlayOn WSL distro awake from the Windows parent node-agent.
 *
 * WSL2 often stops a distro shortly after the last Windows-side wsl.exe session
 * exits — even with systemd services and vmIdleTimeout=-1. Hold an open session
 * and periodically ensure the sibling agent is running.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { isWslNodeId, WSL_DISTRO_NAME } from "@playon/shared";

const DEFAULT_INTERVAL_MS = 15_000;

function runWsl(args: string[], timeoutMs: number): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    const child = spawn("wsl.exe", args, {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    const onChunk = (buf: Buffer) => {
      out += buf.toString("utf8");
    };
    child.stdout?.on("data", onChunk);
    child.stderr?.on("data", onChunk);
    const timer = setTimeout(() => {
      child.kill();
      resolve({ code: 1, out: out.trim() });
    }, timeoutMs);
    child.on("error", () => {
      clearTimeout(timer);
      resolve({ code: 1, out: out.trim() });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, out: out.replace(/\0/g, "").trim() });
    });
  });
}

export function shouldRunWslKeepalive(opts: {
  platform?: NodeJS.Platform;
  nodeId?: string;
  enabledEnv?: string | undefined;
}): boolean {
  const platform = opts.platform ?? process.platform;
  if (platform !== "win32") return false;
  if (isWslNodeId(opts.nodeId)) return false;
  const flag = (opts.enabledEnv ?? process.env.PLAYON_WSL_KEEPALIVE ?? "1").trim().toLowerCase();
  return flag !== "0" && flag !== "false" && flag !== "off";
}

async function distroExists(distroName: string): Promise<boolean> {
  const listed = await runWsl(["-l", "-q"], 15_000);
  if (listed.code !== 0) return false;
  const names = listed.out
    .split(/\r?\n/)
    .map((l) => l.replace(/\0/g, "").trim())
    .filter(Boolean);
  return names.includes(distroName);
}

/** Ensure playon-linux agent is running (wakes the distro if stopped). */
export async function pokeWslSiblingAgent(
  distroName: string = process.env.PLAYON_WSL_DISTRO?.trim() || WSL_DISTRO_NAME,
): Promise<boolean> {
  if (!(await distroExists(distroName))) return false;
  const start = await runWsl(
    ["-d", distroName, "-u", "root", "--", "systemctl", "start", "playon-node-agent.service"],
    45_000,
  );
  return start.code === 0;
}

function spawnHoldSession(distroName: string): ChildProcess {
  // Long-lived Windows↔WSL session so the distro is not considered idle.
  return spawn(
    "wsl.exe",
    ["-d", distroName, "-u", "root", "--", "bash", "-lc", "exec sleep infinity"],
    {
      windowsHide: true,
      stdio: "ignore",
      detached: false,
    },
  );
}

export function startWslKeepalive(opts: {
  nodeId: string;
  intervalMs?: number;
  distroName?: string;
}): (() => void) | null {
  if (!shouldRunWslKeepalive({ nodeId: opts.nodeId })) return null;
  const intervalMs = opts.intervalMs ?? Number(process.env.PLAYON_WSL_KEEPALIVE_MS ?? DEFAULT_INTERVAL_MS);
  const distroName = opts.distroName ?? (process.env.PLAYON_WSL_DISTRO?.trim() || WSL_DISTRO_NAME);

  let busy = false;
  let hold: ChildProcess | null = null;

  const ensureHold = async () => {
    if (!(await distroExists(distroName))) return;
    if (hold && !hold.killed && hold.exitCode == null) return;
    const child = spawnHoldSession(distroName);
    hold = child;
    child.on("exit", (code, signal) => {
      if (hold === child) hold = null;
      console.warn(
        `[node-agent] wsl hold session ended distro=${distroName} code=${code ?? "null"} signal=${signal ?? "null"}`,
      );
    });
    child.on("error", (err) => {
      if (hold === child) hold = null;
      console.warn(`[node-agent] wsl hold session error: ${err.message}`);
    });
    console.log(`[node-agent] wsl hold session started distro=${distroName}`);
  };

  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      await ensureHold();
      const ok = await pokeWslSiblingAgent(distroName);
      if (ok) {
        console.log(`[node-agent] wsl keepalive ok distro=${distroName}`);
      }
    } catch (err) {
      console.warn(`[node-agent] wsl keepalive failed: ${(err as Error).message}`);
    } finally {
      busy = false;
    }
  };

  console.log(`[node-agent] wsl keepalive enabled distro=${distroName} every ${intervalMs}ms`);
  void tick();
  const id = setInterval(() => {
    void tick();
  }, Math.max(5_000, intervalMs));
  return () => {
    clearInterval(id);
    if (hold && !hold.killed) {
      hold.kill();
      hold = null;
    }
  };
}
