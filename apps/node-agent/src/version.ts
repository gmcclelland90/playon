import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Resolve node-agent version from its package.json (stamped at package time). */
export function readAgentVersion(): string {
  const candidates = [
    path.join(process.cwd(), "apps", "node-agent", "package.json"),
    path.join(process.cwd(), "package.json"),
  ];
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    candidates.unshift(path.join(here, "..", "package.json"));
    candidates.push(path.join(here, "..", "..", "..", "package.json"));
  } catch {
    // ignore
  }
  for (const file of candidates) {
    try {
      if (!fs.existsSync(file)) continue;
      const pkg = JSON.parse(fs.readFileSync(file, "utf8")) as {
        name?: string;
        version?: string;
      };
      if (!pkg.version) continue;
      if (pkg.name === "@playon/node-agent" || pkg.name === "playon-node" || pkg.name === "playon") {
        return pkg.version;
      }
      // staged apps/node-agent/package.json
      if (file.includes(`${path.sep}node-agent${path.sep}`)) return pkg.version;
    } catch {
      // try next
    }
  }
  return "0.0.0";
}
