import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findRepoRoot } from "../config.js";

/** Read PlayOn Home version from nearest package.json (root / staged Home). */
export function readAppVersion(cwd: string = process.cwd()): string {
  const candidates = [
    path.join(cwd, "package.json"),
    path.join(findRepoRoot(cwd), "package.json"),
  ];
  // When running from apps/api/dist, also walk up from this file.
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    candidates.push(path.join(here, "..", "..", "..", "..", "package.json"));
    candidates.push(path.join(here, "..", "..", "package.json"));
  } catch {
    // ignore
  }
  for (const file of candidates) {
    try {
      if (!fs.existsSync(file)) continue;
      const pkg = JSON.parse(fs.readFileSync(file, "utf8")) as { version?: string; name?: string };
      if (pkg.version && (pkg.name === "playon" || pkg.name === "playon-node" || !pkg.name)) {
        return pkg.version;
      }
      if (pkg.version && file.endsWith(`${path.sep}package.json`)) {
        // Prefer workspace root version when present
        const root = findRepoRoot(path.dirname(file));
        const rootPkgPath = path.join(root, "package.json");
        if (fs.existsSync(rootPkgPath)) {
          const rootPkg = JSON.parse(fs.readFileSync(rootPkgPath, "utf8")) as { version?: string };
          if (rootPkg.version) return rootPkg.version;
        }
        return pkg.version;
      }
    } catch {
      // try next
    }
  }
  return "0.0.0";
}
