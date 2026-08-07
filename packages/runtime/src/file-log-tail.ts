import fs from "node:fs";
import type { LogFollowHandle } from "./types.js";

export function readLogFileTail(filePath: string, maxLines = 40): string[] {
  if (!fs.existsSync(filePath)) return [];
  try {
    const text = fs.readFileSync(filePath, "utf8");
    const lines = text.split(/\r?\n/).filter((l) => l.length > 0);
    return lines.slice(-Math.max(1, maxLines));
  } catch {
    return [];
  }
}

/**
 * Poll a growing log file and emit new complete lines.
 * Starts at EOF by default so historical seed can come from readLogFileTail.
 */
export function followLogFile(
  filePath: string,
  onLine: (line: string) => void,
  opts?: { fromStart?: boolean; pollMs?: number },
): LogFollowHandle {
  const pollMs = opts?.pollMs ?? 500;
  let offset = 0;
  let buf = "";
  let aborted = false;
  let timer: ReturnType<typeof setInterval> | null = null;

  if (!opts?.fromStart && fs.existsSync(filePath)) {
    try {
      offset = fs.statSync(filePath).size;
    } catch {
      offset = 0;
    }
  }

  const tick = () => {
    if (aborted) return;
    try {
      if (!fs.existsSync(filePath)) return;
      const st = fs.statSync(filePath);
      if (st.size < offset) {
        // Truncated / rotated
        offset = 0;
        buf = "";
      }
      if (st.size === offset) return;
      const fd = fs.openSync(filePath, "r");
      try {
        const len = st.size - offset;
        const chunk = Buffer.alloc(len);
        fs.readSync(fd, chunk, 0, len, offset);
        offset = st.size;
        buf += chunk.toString("utf8");
        const parts = buf.split(/\r?\n/);
        buf = parts.pop() ?? "";
        for (const line of parts) {
          if (line) onLine(line);
        }
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      // best-effort
    }
  };

  timer = setInterval(tick, pollMs);
  // Kick once immediately in case writers already flushed.
  tick();

  return {
    abort: () => {
      if (aborted) return;
      aborted = true;
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },
  };
}
