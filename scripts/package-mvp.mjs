#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const out = path.join(root, "dist-package");
const stage = path.join(out, "playon");

const excludeDirNames = new Set([
  "node_modules",
  ".git",
  "dist",
  "dist-package",
  "data",
  ".turbo",
]);

function shouldSkip(relPosix) {
  const parts = relPosix.split("/");
  if (parts.some((p) => excludeDirNames.has(p))) return true;
  if (/\.(sqlite|db)$/i.test(relPosix)) return true;
  return false;
}

function copyTree(from, to, rel = "") {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const relChild = rel ? `${rel}/${entry.name}` : entry.name;
    if (shouldSkip(relChild.replace(/\\/g, "/"))) continue;
    const src = path.join(from, entry.name);
    const dest = path.join(to, entry.name);
    if (entry.isDirectory()) copyTree(src, dest, relChild);
    else fs.copyFileSync(src, dest);
  }
}

fs.rmSync(out, { recursive: true, force: true });
copyTree(root, stage);

fs.writeFileSync(
  path.join(stage, "INSTALL.md"),
  `# PlayOn MVP install

## Prerequisites

- Node.js 22 LTS
- pnpm 9 (\`corepack enable && corepack prepare pnpm@9.15.4 --activate\`)
- Docker Desktop / Engine optional (required for real Minecraft Paper containers)

## Setup

\`\`\`bash
pnpm install
pnpm verify
pnpm dev
\`\`\`

- Web UI: http://127.0.0.1:5173
- API: http://127.0.0.1:8787

Default test/dev modes use \`PLAYON_LLM_MODE=mock\` and \`PLAYON_RUNTIME=mock\`.
Set \`PLAYON_RUNTIME=docker\` when Docker is available for container skills.
`,
);

const zipPath = path.join(out, "playon-mvp.zip");
const isWin = process.platform === "win32";
if (isWin) {
  execFileSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-Command",
      `Compress-Archive -Path '${stage.replace(/'/g, "''")}' -DestinationPath '${zipPath.replace(/'/g, "''")}' -Force`,
    ],
    { stdio: "inherit" },
  );
} else {
  execFileSync("zip", ["-qr", zipPath, "playon"], { cwd: out, stdio: "inherit" });
}

if (!fs.existsSync(zipPath)) {
  console.error("Failed to create", zipPath);
  process.exit(1);
}
console.log("Packaged MVP at", zipPath);
