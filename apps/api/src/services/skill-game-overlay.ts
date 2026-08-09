import fs from "node:fs";
import path from "node:path";

export type SkillGameOverlayFile = {
  /** Path relative to skill `files/` (posix). */
  relPath: string;
  absPath: string;
};

/** Enumerate files under skill `files/` for local copy or remote push. */
export function listSkillGameOverlayFiles(skillPath: string): SkillGameOverlayFile[] {
  const overlayRoot = path.join(skillPath, "files");
  if (!fs.existsSync(overlayRoot) || !fs.statSync(overlayRoot).isDirectory()) {
    return [];
  }
  const out: SkillGameOverlayFile[] = [];
  const walk = (srcDir: string, rel = "") => {
    for (const name of fs.readdirSync(srcDir)) {
      const src = path.join(srcDir, name);
      const destRel = rel ? `${rel}/${name}` : name;
      const st = fs.statSync(src);
      if (st.isDirectory()) {
        walk(src, destRel);
        continue;
      }
      out.push({ relPath: destRel.replace(/\\/g, "/"), absPath: src });
    }
  };
  walk(overlayRoot);
  return out;
}

/**
 * Copy skill `files/` into the server `game/` jail before native start.
 * Existing destinations are left alone (host/operator edits win).
 */
export function ensureSkillGameOverlay(skillPath: string, gameDir: string): string[] {
  const files = listSkillGameOverlayFiles(skillPath);
  if (!files.length) return [];
  if (!fs.existsSync(gameDir)) {
    fs.mkdirSync(gameDir, { recursive: true });
  }

  const copied: string[] = [];
  for (const file of files) {
    const dest = path.join(gameDir, ...file.relPath.split("/"));
    if (fs.existsSync(dest)) continue;
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(file.absPath, dest);
    copied.push(file.relPath);
  }
  return copied;
}
