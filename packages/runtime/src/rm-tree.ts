import fs from "node:fs";

export function isLockedFsError(err: unknown): boolean {
  const code =
    err && typeof err === "object" && "code" in err ? String((err as { code: unknown }).code) : "";
  return code === "EBUSY" || code === "EPERM" || code === "EACCES";
}

/**
 * Remove a tree, retrying Windows handle-release races (dying game / cmd.exe).
 * Callers must already have stopped processes that still hold files.
 */
export function rmTreeWithRetrySync(target: string): void {
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
      if (!isLockedFsError(err) || i === attempts - 1) throw err;
      const waitMs = 50 * 2 ** Math.min(i, 5);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, waitMs);
    }
  }
  throw lastErr;
}
