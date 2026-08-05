#!/usr/bin/env node
/**
 * Build a portable PlayOn Node release (node-agent + runtime deps + bundled Node).
 * Requires a prior `pnpm build`. Does not require Docker.
 *
 * Output:
 *   dist-node/playon-node-<version>-windows-x64.zip
 *   dist-node/playon-node-<version>-linux-x64.tar.gz
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, execSync } from "node:child_process";
import https from "node:https";
import { createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const out = path.join(root, "dist-node");
const stage = path.join(out, "playon-node");
const version = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version;
const nodeVersion = process.env.PLAYON_BUNDLE_NODE_VERSION?.trim() || "22.17.0";
const isWin = process.platform === "win32";
const platformTag = isWin ? "windows-x64" : "linux-x64";

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

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const follow = (current, redirects = 0) => {
      if (redirects > 5) {
        reject(new Error(`Too many redirects for ${url}`));
        return;
      }
      https
        .get(current, (res) => {
          if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            res.resume();
            follow(res.headers.location, redirects + 1);
            return;
          }
          if (res.statusCode !== 200) {
            res.resume();
            reject(new Error(`Download failed ${res.statusCode}: ${current}`));
            return;
          }
          const outStream = createWriteStream(dest);
          pipeline(res, outStream).then(resolve).catch(reject);
        })
        .on("error", reject);
    };
    follow(url);
  });
}

async function vendorNode() {
  const runtimeNode = path.join(stage, "runtime", "node");
  fs.mkdirSync(path.join(stage, "runtime"), { recursive: true });
  const cacheDir = path.join(out, ".node-cache");
  fs.mkdirSync(cacheDir, { recursive: true });

  const distName = isWin
    ? `node-v${nodeVersion}-win-x64`
    : `node-v${nodeVersion}-linux-x64`;
  const archiveName = isWin ? `${distName}.zip` : `${distName}.tar.gz`;
  const url = `https://nodejs.org/dist/v${nodeVersion}/${archiveName}`;
  const archivePath = path.join(cacheDir, archiveName);

  if (!fs.existsSync(archivePath)) {
    console.log(`==> Downloading Node ${nodeVersion} (${platformTag})`);
    await download(url, archivePath);
  } else {
    console.log(`==> Using cached Node archive ${archiveName}`);
  }

  const extractDir = path.join(cacheDir, distName);
  fs.rmSync(extractDir, { recursive: true, force: true });
  fs.rmSync(runtimeNode, { recursive: true, force: true });

  if (isWin) {
    execFileSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-Command",
        `Expand-Archive -Path '${archivePath.replace(/'/g, "''")}' -DestinationPath '${cacheDir.replace(/'/g, "''")}' -Force`,
      ],
      { stdio: "inherit" },
    );
  } else {
    execFileSync("tar", ["-xzf", archivePath, "-C", cacheDir], { stdio: "inherit" });
  }

  if (!fs.existsSync(extractDir)) {
    console.error(`Node extract missing: ${extractDir}`);
    process.exit(1);
  }
  fs.renameSync(extractDir, runtimeNode);
  console.log(`==> Vendored Node → runtime/node`);
}

function bundledNodePaths() {
  const nodeRoot = path.join(stage, "runtime", "node");
  if (isWin) {
    return {
      pathPrefix: nodeRoot,
      nodeBin: path.join(nodeRoot, "node.exe"),
      corepackJs: path.join(nodeRoot, "node_modules", "corepack", "dist", "corepack.js"),
    };
  }
  return {
    pathPrefix: path.join(nodeRoot, "bin"),
    nodeBin: path.join(nodeRoot, "bin", "node"),
    corepackJs: path.join(nodeRoot, "lib", "node_modules", "corepack", "dist", "corepack.js"),
  };
}

function installProdDeps() {
  console.log("==> pnpm install --prod (node stage, using bundled Node)");
  fs.writeFileSync(
    path.join(stage, ".npmrc"),
    ["node-linker=hoisted", "shamefully-hoist=true", "auto-install-peers=true"].join("\n") + "\n",
  );

  const { pathPrefix, nodeBin, corepackJs } = bundledNodePaths();
  if (!fs.existsSync(nodeBin)) {
    console.error(`Bundled Node missing at ${nodeBin}`);
    process.exit(1);
  }

  const env = {
    ...process.env,
    CI: "true",
    PATH: `${pathPrefix}${path.delimiter}${process.env.PATH || ""}`,
    npm_config_runtime: "node",
    npm_config_target: nodeVersion,
    npm_config_arch: "x64",
  };

  try {
    if (fs.existsSync(corepackJs)) {
      execFileSync(nodeBin, [corepackJs, "enable"], { cwd: stage, stdio: "inherit", env });
      execFileSync(nodeBin, [corepackJs, "prepare", "pnpm@9.15.4", "--activate"], {
        cwd: stage,
        stdio: "inherit",
        env,
      });
    }
    execSync("pnpm install --prod --frozen-lockfile=false", {
      cwd: stage,
      stdio: "inherit",
      env,
      shell: isWin,
    });
  } catch (err) {
    console.error("pnpm install --prod failed in node stage:", err.message);
    process.exit(1);
  }
}

mustExist(path.join(root, "apps/node-agent/dist/index.js"), "node-agent dist");
mustExist(path.join(root, "packages/shared/dist/index.js"), "shared dist");
mustExist(path.join(root, "packages/runtime/dist/index.js"), "runtime dist");

if (process.arch !== "x64") {
  console.warn(`Warning: packaging on ${process.arch}; official artifacts target x64.`);
}

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(stage, { recursive: true });

const rootPkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
fs.writeFileSync(
  path.join(stage, "package.json"),
  JSON.stringify(
    {
      name: "playon-node",
      private: true,
      version,
      description: "PlayOn remote node-agent package",
      packageManager: rootPkg.packageManager,
      engines: rootPkg.engines,
      scripts: {
        start: "node apps/node-agent/dist/index.js",
      },
    },
    null,
    2,
  ) + "\n",
);
fs.writeFileSync(
  path.join(stage, "pnpm-workspace.yaml"),
  ["packages:", '  - "apps/node-agent"', '  - "packages/*"', ""].join("\n"),
);

for (const pkg of ["shared", "runtime"]) {
  const from = path.join(root, "packages", pkg);
  const to = path.join(stage, "packages", pkg);
  copyFile(path.join(from, "package.json"), path.join(to, "package.json"));
  copyTree(path.join(from, "dist"), path.join(to, "dist"));
}

{
  const from = path.join(root, "apps/node-agent");
  const to = path.join(stage, "apps/node-agent");
  const pkg = JSON.parse(fs.readFileSync(path.join(from, "package.json"), "utf8"));
  pkg.version = version;
  fs.mkdirSync(to, { recursive: true });
  fs.writeFileSync(path.join(to, "package.json"), JSON.stringify(pkg, null, 2) + "\n");
  copyTree(path.join(from, "dist"), path.join(to, "dist"));
}

copyTree(path.join(root, "deploy"), path.join(stage, "deploy"), (name) => {
  // Keep install + apply helpers; skip bulky unrelated trees if any
  return name !== "node_modules";
});

copyFile(
  path.join(root, "deploy/portable/apply-update.mjs"),
  path.join(stage, "deploy/portable/apply-update.mjs"),
);

fs.writeFileSync(
  path.join(stage, "start-node.sh"),
  `#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
exec "$ROOT/runtime/node/bin/node" "$ROOT/apps/node-agent/dist/index.js"
`,
);
fs.writeFileSync(
  path.join(stage, "start-node.ps1"),
  `$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
& (Join-Path $Root "runtime\\node\\node.exe") (Join-Path $Root "apps\\node-agent\\dist\\index.js")
`,
);
if (!isWin) {
  try {
    fs.chmodSync(path.join(stage, "start-node.sh"), 0o755);
  } catch {
    // ignore
  }
}

fs.writeFileSync(
  path.join(stage, "INSTALL.md"),
  `# PlayOn Node ${version} (${platformTag})

Remote runtime host for a PlayOn Home control plane.

## Quick start

Prefer adding a node from Home (**Settings → Nodes**). Manual:

\`\`\`bash
# Linux (from this extracted tree)
sudo bash deploy/install-node.sh --api http://HOME:8787 --token "$PLAYON_NODE_TOKEN" --node-id spare-1
\`\`\`

Or use the published one-liner (downloads this package from the release manifest):

\`\`\`bash
curl -fsSL https://playon.games/install-node | sudo bash -s -- --api http://HOME:8787 --token "$TOKEN"
\`\`\`

Includes Node.js ${nodeVersion} and production dependencies for **${platformTag}**.
`,
);

await vendorNode();
installProdDeps();

const baseName = `playon-node-${version}-${platformTag}`;
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
  console.log("Packaged Node at", zipPath);
} else {
  const tarPath = path.join(out, `${baseName}.tar.gz`);
  execFileSync("tar", ["-czf", tarPath, "-C", out, "playon-node"], { stdio: "inherit" });
  console.log("Packaged Node at", tarPath);
}
