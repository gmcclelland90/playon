#!/usr/bin/env node
/**
 * Build a PlayOn Home release tarball (control-plane + node-agent + skills + web).
 * Requires a prior `pnpm build`. Does not require Docker.
 *
 * Output: dist-home/playon-home-<version>.tar.gz (and .zip on Windows)
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const out = path.join(root, "dist-home");
const stage = path.join(out, "playon");
const version = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version;

function mustExist(p, label) {
  if (!fs.existsSync(p)) {
    console.error(`Missing ${label}: ${p} — run pnpm build first`);
    process.exit(1);
  }
}

function copyTree(from, to, filter = () => true) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    if (!filter(entry.name, from)) continue;
    const src = path.join(from, entry.name);
    const dest = path.join(to, entry.name);
    if (entry.isDirectory()) copyTree(src, dest, filter);
    else fs.copyFileSync(src, dest);
  }
}

function copyFile(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
}

mustExist(path.join(root, "apps/api/dist/index.js"), "api dist");
mustExist(path.join(root, "apps/web/dist/index.html"), "web dist");
mustExist(path.join(root, "apps/node-agent/dist/index.js"), "node-agent dist");

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(stage, { recursive: true });

// Root workspace
copyFile(path.join(root, "package.json"), path.join(stage, "package.json"));
copyFile(path.join(root, "pnpm-workspace.yaml"), path.join(stage, "pnpm-workspace.yaml"));
copyFile(path.join(root, "pnpm-lock.yaml"), path.join(stage, "pnpm-lock.yaml"));

for (const pkg of ["shared", "runtime", "agent-core", "server-query"]) {
  const from = path.join(root, "packages", pkg);
  const to = path.join(stage, "packages", pkg);
  copyFile(path.join(from, "package.json"), path.join(to, "package.json"));
  copyTree(path.join(from, "dist"), path.join(to, "dist"));
}

for (const app of ["api", "node-agent"]) {
  const from = path.join(root, "apps", app);
  const to = path.join(stage, "apps", app);
  copyFile(path.join(from, "package.json"), path.join(to, "package.json"));
  copyTree(path.join(from, "dist"), path.join(to, "dist"));
}
copyTree(path.join(root, "apps/web/dist"), path.join(stage, "apps/web/dist"));
// bootstrap.sql resolution fallback
copyFile(
  path.join(root, "apps/api/src/db/bootstrap.sql"),
  path.join(stage, "apps/api/src/db/bootstrap.sql"),
);

// Home ships platform core only — curated games.* come from playon.games catalog.
copyTree(
  path.join(root, "skills", "platform"),
  path.join(stage, "skills", "platform"),
  (name) => name !== "node_modules",
);

copyTree(path.join(root, "deploy"), path.join(stage, "deploy"));
copyTree(path.join(root, "infra/control-plane"), path.join(stage, "infra/control-plane"));

fs.writeFileSync(
  path.join(stage, "INSTALL.md"),
  `# PlayOn Home ${version}

Primary install (no Docker required):

\`\`\`bash
# from extracted tarball, as root or with sudo
sudo bash deploy/install.sh
\`\`\`

Or set env first:

\`\`\`bash
export PLAYON_ADVERTISE_HOST=192.168.1.50
export PLAYON_RUNTIME=native   # or docker if Engine is installed
sudo -E bash deploy/install.sh
\`\`\`

Open http://$PLAYON_ADVERTISE_HOST:8787 — create Owner, save Venice key.

Game skills install on demand from the playon.games library (chat or Settings → Skill library).
Platform core skills are bundled. See docs/deploy.md for Node join, Docker panel, and Cloud.
`,
);

const baseName = `playon-home-${version}`;
const isWin = process.platform === "win32";
if (isWin) {
  const zipPath = path.join(out, `${baseName}.zip`);
  execFileSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-Command",
      `Compress-Archive -Path '${stage.replace(/'/g, "''")}' -DestinationPath '${zipPath.replace(/'/g, "''")}' -Force`,
    ],
    { stdio: "inherit" },
  );
  console.log("Packaged Home at", zipPath);
} else {
  const tarPath = path.join(out, `${baseName}.tar.gz`);
  execFileSync("tar", ["-czf", tarPath, "-C", out, "playon"], { stdio: "inherit" });
  console.log("Packaged Home at", tarPath);
}
