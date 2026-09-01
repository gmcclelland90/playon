import fs from "node:fs";
import path from "node:path";
import { INSTANCE_INI_HINT_DIRS } from "@playon/shared";

const SKIP_DIRS = new Set(["node_modules", ".git", "steamapps", "logs", "Workshop"]);

/** Jail-relative *.ini paths, hint dirs first (PZ Server/*.ini), then a bounded walk. */
export function listLocalIniRelPaths(dataPath: string): string[] {
  const found: string[] = [];
  const seen = new Set<string>();
  const add = (rel: string) => {
    const key = rel.replace(/\\/g, "/");
    if (seen.has(key)) return;
    seen.add(key);
    found.push(key);
  };

  for (const dir of INSTANCE_INI_HINT_DIRS) {
    const abs = path.join(dataPath, ...dir.split("/"));
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(abs, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      if (ent.isFile() && /\.ini$/i.test(ent.name)) add(`${dir}/${ent.name}`);
    }
  }

  const visit = (rel: string, depth: number) => {
    if (found.length >= 40 || depth > 4) return;
    const abs = rel === "." ? dataPath : path.join(dataPath, ...rel.split("/"));
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(abs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      if (found.length >= 40) return;
      const child = rel === "." ? ent.name : `${rel}/${ent.name}`;
      if (ent.isDirectory()) {
        if (SKIP_DIRS.has(ent.name)) continue;
        visit(child.replace(/\\/g, "/"), depth + 1);
      } else if (ent.isFile() && /\.ini$/i.test(ent.name)) {
        add(child.replace(/\\/g, "/"));
      }
    }
  };
  visit(".", 0);
  return found;
}
