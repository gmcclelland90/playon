import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { dockerSocketAvailable } from "./host-capabilities.js";

export function isLockedFsError(err: unknown): boolean {
  const code =
    err && typeof err === "object" && "code" in err ? String((err as { code: unknown }).code) : "";
  return code === "EBUSY" || code === "EPERM" || code === "EACCES";
}

/** Best-effort `u+w` walk so mode-locked trees we own can be unlinked (#972). */
export function chmodTreeWritableSync(root: string): void {
  const visit = (target: string): void => {
    let st: fs.Stats;
    try {
      st = fs.lstatSync(target);
    } catch {
      return;
    }
    if (st.isSymbolicLink()) return;
    if (st.isDirectory()) {
      try {
        fs.chmodSync(target, st.mode | 0o200);
      } catch {
        /* root-owned / immutable */
      }
      let entries: string[] = [];
      try {
        entries = fs.readdirSync(target);
      } catch {
        return;
      }
      for (const name of entries) visit(path.join(target, name));
      try {
        // Re-apply after children in case a tool flipped the dir mode again.
        const mode = fs.statSync(target).mode;
        fs.chmodSync(target, mode | 0o200);
      } catch {
        /* ignore */
      }
      return;
    }
    try {
      fs.chmodSync(target, st.mode | 0o200);
    } catch {
      /* ignore */
    }
  };
  visit(root);
}

/**
 * Clear / remove a tree as root inside a helper container.
 * Docker game installs often leave root-owned files the host user cannot unlink (#972).
 */
export function dockerForceRemoveTreeSync(target: string): void {
  const abs = path.resolve(target);
  if (!fs.existsSync(abs)) return;

  // Prefer clearing contents while mounted at the target (jail root is usually user-owned).
  try {
    execFileSync(
      "docker",
      [
        "run",
        "--rm",
        "-v",
        `${abs}:/playon-rm`,
        "alpine:3.20",
        "sh",
        "-c",
        "rm -rf /playon-rm/* /playon-rm/.[!.]* /playon-rm/..?*",
      ],
      { stdio: "ignore" },
    );
  } catch {
    /* image pull / docker down — fall through */
  }

  try {
    fs.rmSync(abs, { recursive: true, force: true, maxRetries: 0 });
  } catch {
    /* may still be root-owned shell dir */
  }
  if (!fs.existsSync(abs)) return;

  const parent = path.dirname(abs);
  const base = path.basename(abs);
  if (!base || base === "." || base === "..") {
    throw new Error(`docker_rm_invalid_target: ${target}`);
  }
  execFileSync(
    "docker",
    ["run", "--rm", "-v", `${parent}:/playon-rm-parent`, "alpine:3.20", "rm", "-rf", `--`, `/playon-rm-parent/${base}`],
    { stdio: "ignore" },
  );
}

export type RmTreeHooks = {
  chmodWritable?: (target: string) => void;
  dockerAvailable?: () => boolean;
  dockerForceRemove?: (target: string) => void;
};

/**
 * Remove a tree, retrying Windows handle-release races (dying game / cmd.exe).
 * On Linux, also recovers from Docker root-owned / mode-locked leftovers (#972–#976).
 * Callers must already have stopped processes that still hold files.
 */
export function rmTreeWithRetrySync(target: string, hooks: RmTreeHooks = {}): void {
  const chmodWritable = hooks.chmodWritable ?? chmodTreeWritableSync;
  const dockerAvailable = hooks.dockerAvailable ?? dockerSocketAvailable;
  const dockerForceRemove = hooks.dockerForceRemove ?? dockerForceRemoveTreeSync;

  const attempts = process.platform === "win32" ? 8 : 1;
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      fs.rmSync(target, {
        recursive: true,
        force: true,
        maxRetries: process.platform === "win32" ? 8 : 0,
        retryDelay: 80,
      });
      return;
    } catch (err) {
      lastErr = err;
      if (!isLockedFsError(err) || i === attempts - 1) break;
      const waitMs = 50 * 2 ** Math.min(i, 5);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, waitMs);
    }
  }

  if (!isLockedFsError(lastErr)) throw lastErr;

  // Mode-locked dirs we own (common after installs) — chmod then retry.
  try {
    chmodWritable(target);
    fs.rmSync(target, { recursive: true, force: true, maxRetries: 0 });
    return;
  } catch (err) {
    lastErr = err;
    if (!isLockedFsError(err)) throw err;
  }

  // Root-owned bind-mount residue from Docker — remove as root via helper container.
  if (dockerAvailable()) {
    try {
      dockerForceRemove(target);
      if (!fs.existsSync(target)) return;
      fs.rmSync(target, { recursive: true, force: true, maxRetries: 0 });
      return;
    } catch (err) {
      lastErr = err;
    }
  }

  if (!fs.existsSync(target)) return;
  throw lastErr;
}
