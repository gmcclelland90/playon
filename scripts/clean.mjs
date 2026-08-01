import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function rm(target) {
  fs.rmSync(target, { recursive: true, force: true });
}

function walk(dir, onDir) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      onDir(full, entry.name);
      if (entry.name !== "node_modules" && entry.name !== ".git") {
        walk(full, onDir);
      }
    }
  }
}

rm(path.join(root, ".turbo"));
for (const top of ["packages", "apps"]) {
  walk(path.join(root, top), (full, name) => {
    if (name === "dist" || name === ".turbo") rm(full);
  });
}

// Stale incremental info makes tsc skip emit after dist deletion.
walk(root, () => undefined);
for (const top of ["packages", "apps"]) {
  const base = path.join(root, top);
  if (!fs.existsSync(base)) continue;
  for (const pkg of fs.readdirSync(base)) {
    const pkgDir = path.join(base, pkg);
    if (!fs.statSync(pkgDir).isDirectory()) continue;
    for (const file of fs.readdirSync(pkgDir)) {
      if (file.endsWith(".tsbuildinfo")) rm(path.join(pkgDir, file));
    }
  }
}

console.log("clean: removed dist, .turbo, and tsbuildinfo artifacts");
