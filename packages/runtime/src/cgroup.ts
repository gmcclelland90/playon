import fs from "node:fs";

/**
 * cgroup v2 path from `/proc/<pid>/cgroup` (`0::/system.slice/…`).
 * `detached` is a new session/pgrp — it is not a cgroup escape.
 */
export function readCgroupRelativePath(pid: number): string | null {
  if (process.platform === "win32") return null;
  try {
    const text = fs.readFileSync(`/proc/${pid}/cgroup`, "utf8");
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const parts = trimmed.split(":");
      if (parts.length < 3) continue;
      const rel = parts.slice(2).join(":") || "/";
      return rel.startsWith("/") ? rel : `/${rel}`;
    }
    return null;
  } catch {
    return null;
  }
}

function cgroupProcsFile(relPath: string): string {
  const rel = relPath === "/" ? "" : relPath;
  return `/sys/fs/cgroup${rel}/cgroup.procs`;
}

/**
 * Best-effort move out of the agent unit cgroup so `KillMode=control-group`
 * (units OTA cannot rewrite) does not SIGTERM the game / FIFO holder.
 * Often EACCES without privileges — NZL-shaped `KillMode=process` is the
 * path that must still work when this returns false.
 */
export function moveProcessOutOfAgentCgroup(pid: number): boolean {
  if (process.platform === "win32" || !pid) return false;
  const self = readCgroupRelativePath(process.pid);
  const dests: string[] = [];
  if (process.ppid > 1) {
    const parentCg = readCgroupRelativePath(process.ppid);
    if (parentCg && parentCg !== self) dests.push(parentCg);
  }
  if (self && self !== "/") {
    dests.push(self.replace(/\/[^/]+$/, "") || "/");
  }
  dests.push("/");
  const seen = new Set<string>();
  for (const dest of dests) {
    if (!dest || seen.has(dest) || dest === self) continue;
    seen.add(dest);
    try {
      fs.writeFileSync(cgroupProcsFile(dest), `${pid}\n`);
      const now = readCgroupRelativePath(pid);
      if (now && now !== self) return true;
    } catch {
      /* EACCES / ENOENT / EBUSY */
    }
  }
  return false;
}
