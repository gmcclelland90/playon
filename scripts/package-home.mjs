#!/usr/bin/env node
/**
 * Build a portable PlayOn Home release (control-plane + node-agent + skills + web).
 * Requires a prior `pnpm build`. Does not require Docker.
 *
 * Vendors Node 22 + production node_modules for the current OS/arch.
 * Output:
 *   dist-home/playon-home-<version>-windows-x64.zip
 *   dist-home/playon-home-<version>-linux-x64.tar.gz
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
const out = path.join(root, "dist-home");
const stage = path.join(out, "playon");
const version = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version;
/** Pin portable runtime to Node 22 LTS (matches package engines), not the packager's Node. */
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
  console.log("==> pnpm install --prod (stage, using bundled Node)");
  const npmrc = path.join(stage, ".npmrc");
  fs.writeFileSync(
    npmrc,
    ["node-linker=hoisted", "shamefully-hoist=true", "auto-install-peers=true"].join("\n") + "\n",
  );

  const { pathPrefix, nodeBin, corepackJs } = bundledNodePaths();
  if (!fs.existsSync(nodeBin)) {
    console.error(`Bundled Node missing at ${nodeBin} — vendor Node before install`);
    process.exit(1);
  }

  // Ensure native modules (better-sqlite3) compile against the shipped Node ABI.
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
    // Prefer host pnpm on PATH but with bundled node first so node-gyp targets ABI correctly.
    execSync("pnpm install --prod --frozen-lockfile=false", {
      cwd: stage,
      stdio: "inherit",
      env,
      shell: isWin,
    });
  } catch (err) {
    console.error("pnpm install --prod failed in stage:", err.message);
    process.exit(1);
  }

  try {
    execSync("pnpm rebuild better-sqlite3", {
      cwd: stage,
      stdio: "inherit",
      env,
      shell: isWin,
    });
  } catch {
    console.warn("pnpm rebuild better-sqlite3 skipped or failed — package may still work via prebuild");
  }

  const sqlite = path.join(stage, "node_modules", "better-sqlite3");
  const alt = path.join(stage, "apps", "api", "node_modules", "better-sqlite3");
  if (!fs.existsSync(sqlite) && !fs.existsSync(alt) && !fs.existsSync(path.join(stage, "node_modules", ".pnpm"))) {
    console.warn("Warning: better-sqlite3 not found at expected paths; verify package on target OS.");
  }
}

mustExist(path.join(root, "apps/api/dist/index.js"), "api dist");
mustExist(path.join(root, "apps/web/dist/index.html"), "web dist");
mustExist(path.join(root, "apps/node-agent/dist/index.js"), "node-agent dist");

if (process.arch !== "x64") {
  console.warn(`Warning: packaging on ${process.arch}; official artifacts target x64.`);
}

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(stage, { recursive: true });

// Root workspace (filtered — no apps/web package required)
const rootPkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const stageRootPkg = {
  name: rootPkg.name,
  private: true,
  version: rootPkg.version,
  description: rootPkg.description,
  packageManager: rootPkg.packageManager,
  engines: rootPkg.engines,
  scripts: {
    start: "node apps/api/dist/index.js",
  },
};
fs.writeFileSync(path.join(stage, "package.json"), JSON.stringify(stageRootPkg, null, 2) + "\n");
fs.writeFileSync(
  path.join(stage, "pnpm-workspace.yaml"),
  ["packages:", '  - "apps/api"', '  - "apps/node-agent"', '  - "packages/*"', ""].join("\n"),
);
// Fresh lock for the filtered Home workspace (full monorepo lock includes apps/web, etc.).

for (const pkg of ["shared", "runtime", "agent-core", "server-query"]) {
  const from = path.join(root, "packages", pkg);
  const to = path.join(stage, "packages", pkg);
  copyFile(path.join(from, "package.json"), path.join(to, "package.json"));
  copyTree(path.join(from, "dist"), path.join(to, "dist"));
}

for (const app of ["api", "node-agent"]) {
  const from = path.join(root, "apps", app);
  const to = path.join(stage, "apps", app);
  const pkg = JSON.parse(fs.readFileSync(path.join(from, "package.json"), "utf8"));
  pkg.version = version;
  fs.mkdirSync(to, { recursive: true });
  fs.writeFileSync(path.join(to, "package.json"), JSON.stringify(pkg, null, 2) + "\n");
  copyTree(path.join(from, "dist"), path.join(to, "dist"));
}
copyTree(path.join(root, "apps/web/dist"), path.join(stage, "apps/web/dist"));
copyFile(
  path.join(root, "apps/api/src/db/bootstrap.sql"),
  path.join(stage, "apps/api/src/db/bootstrap.sql"),
);

copyTree(
  path.join(root, "catalog", "platform"),
  path.join(stage, "catalog", "platform"),
  (name) => name !== "node_modules",
);
copyFile(
  path.join(root, "skills", "import-hints.yaml"),
  path.join(stage, "skills", "import-hints.yaml"),
);

copyTree(path.join(root, "deploy"), path.join(stage, "deploy"));
copyTree(path.join(root, "infra/control-plane"), path.join(stage, "infra/control-plane"));

// Root launchers (same files as deploy/portable templates)
copyFile(
  path.join(root, "deploy/portable/Start-PlayOn.ps1"),
  path.join(stage, "Start-PlayOn.ps1"),
);
copyFile(
  path.join(root, "deploy/portable/start-playon.sh"),
  path.join(stage, "start-playon.sh"),
);
if (!isWin) {
  try {
    fs.chmodSync(path.join(stage, "start-playon.sh"), 0o755);
  } catch {
    // ignore on platforms that don't support chmod the same way
  }
}

fs.writeFileSync(
  path.join(stage, "INSTALL.md"),
  `# PlayOn Home ${version} (${platformTag})

## Quick start (no Node install needed)

1. Extract this archive.
2. Start PlayOn:
   - **Windows:** right-click \`Start-PlayOn.ps1\` → Run with PowerShell
     (or: \`powershell -ExecutionPolicy Bypass -File .\\Start-PlayOn.ps1\`)
   - **Linux:** \`./start-playon.sh\`
3. Your browser opens the admin UI. Create the Owner account, add your Venice API key under Settings, then ask to start a game.
4. Share **Players** link: \`http://<your-lan-ip>:8787/play\`

Data and secrets live in \`./data\` and \`./env\` next to the start script. Keep that folder.

This package already includes Node.js ${nodeVersion} and production dependencies for **${platformTag}**. Use the matching OS download.

## Optional: install as a service (always-on party box)

After the portable folder works:

\`\`\`bash
# Linux
sudo bash deploy/install.sh
\`\`\`

\`\`\`powershell
# Windows (elevated PowerShell)
.\\deploy\\windows\\install.ps1
\`\`\`

## Games

Platform skills are bundled. Install games from the playon.games catalog via chat or **Settings → Skill library**. Docker is only needed for container-based games (e.g. Paper), not for running PlayOn itself. On Linux, service/node install can provision Engine; or use **Settings → Nodes → Install Docker**.
`,
);

await vendorNode();
installProdDeps();

const baseName = `playon-home-${version}-${platformTag}`;
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
