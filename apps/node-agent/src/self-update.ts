import crypto from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { assertAllowedUpdateDownloadUrl } from "@playon/shared";

function copyTree(from: string, to: string): void {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name);
    const dest = path.join(to, entry.name);
    if (entry.isSymbolicLink()) {
      const link = fs.readlinkSync(src);
      try {
        fs.symlinkSync(link, dest);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "EEXIST") {
          fs.rmSync(dest, { recursive: true, force: true });
          fs.symlinkSync(link, dest);
        } else {
          throw err;
        }
      }
    } else if (entry.isDirectory()) {
      copyTree(src, dest);
    } else {
      fs.copyFileSync(src, dest);
    }
  }
}

export function swapInstallTree(opts: {
  target: string;
  source: string;
  preserve: string[];
}): { preserved: string[] } {
  const target = path.resolve(opts.target);
  const source = path.resolve(opts.source);
  const preserve = new Set(opts.preserve);
  if (!fs.existsSync(source)) throw new Error(`update_source_missing: ${source}`);
  fs.mkdirSync(target, { recursive: true });
  const preserved: string[] = [];
  const sourceNames = new Set(fs.readdirSync(source));
  for (const name of fs.readdirSync(target)) {
    if (preserve.has(name)) {
      if (fs.existsSync(path.join(target, name))) preserved.push(name);
      continue;
    }
    if (!sourceNames.has(name)) {
      fs.rmSync(path.join(target, name), { recursive: true, force: true });
    }
  }
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const name = entry.name;
    const dest = path.join(target, name);
    if (preserve.has(name) && fs.existsSync(dest)) continue;
    fs.rmSync(dest, { recursive: true, force: true });
    const src = path.join(source, name);
    if (entry.isDirectory()) copyTree(src, dest);
    else fs.copyFileSync(src, dest);
  }
  return { preserved };
}

export function extractArchive(archivePath: string, destDir: string): string {
  fs.rmSync(destDir, { recursive: true, force: true });
  fs.mkdirSync(destDir, { recursive: true });
  const isZip = archivePath.toLowerCase().endsWith(".zip");
  if (isZip) {
    if (process.platform === "win32") {
      execFileSync(
        "powershell.exe",
        [
          "-NoProfile",
          "-Command",
          `Expand-Archive -Path '${archivePath.replace(/'/g, "''")}' -DestinationPath '${destDir.replace(/'/g, "''")}' -Force`,
        ],
        { stdio: "pipe", timeout: 60000 },
      );
    } else {
      execFileSync("unzip", ["-q", archivePath, "-d", destDir], { stdio: "pipe", timeout: 60000 });
    }
  } else {
    execFileSync("tar", ["-xzf", archivePath, "-C", destDir], { stdio: "pipe", timeout: 60000 });
  }
  for (const name of ["playon-node", "playon"]) {
    const candidate = path.join(destDir, name);
    if (fs.existsSync(path.join(candidate, "package.json"))) return candidate;
  }
  for (const ent of fs.readdirSync(destDir, { withFileTypes: true })) {
    if (!ent.isDirectory()) continue;
    const candidate = path.join(destDir, ent.name);
    if (fs.existsSync(path.join(candidate, "package.json"))) return candidate;
  }
  throw new Error("update_extract_root_missing");
}

export async function performNodeSelfUpdate(args: {
  downloadUrl: string;
  sha256: string;
  version: string;
  preserve?: string[];
  installRoot?: string;
  /** When true (tests), do not schedule process.exit */
  skipExit?: boolean;
}): Promise<{
  version: string;
  installRoot: string;
  preserved: string[];
  restartRequired: boolean;
}> {
  assertAllowedUpdateDownloadUrl(args.downloadUrl);
  const installRoot = path.resolve(
    args.installRoot || process.env.PLAYON_INSTALL_ROOT || process.cwd(),
  );
  const preserve =
    args.preserve ?? ["data", "env", "node.env", "node.env.cmd"];

  const staging = fs.mkdtempSync(path.join(os.tmpdir(), "playon-node-update-"));
  let windowsHelperSpawned = false;
  try {
    const archivePath = path.join(
      staging,
      path.basename(new URL(args.downloadUrl).pathname) || "node-update.bin",
    );
    const res = await fetch(args.downloadUrl, {
      headers: { accept: "application/octet-stream,*/*", "user-agent": "PlayOn-Node" },
    });
    if (!res.ok) throw new Error(`update_download_failed: ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    const sha256 = crypto.createHash("sha256").update(buf).digest("hex");
    if (sha256.toLowerCase() !== args.sha256.toLowerCase()) {
      throw new Error(`update_sha256_mismatch: expected ${args.sha256} got ${sha256}`);
    }
    fs.writeFileSync(archivePath, buf);
    const extracted = extractArchive(archivePath, path.join(staging, "extracted"));

    if (process.platform === "win32" && !args.skipExit) {
      const result = performWindowsSelfUpdate({
        installRoot,
        extracted,
        preserve,
        version: args.version,
      });
      windowsHelperSpawned = true;
      return result;
    }

    const { preserved } = swapInstallTree({
      target: installRoot,
      source: extracted,
      preserve,
    });

    return {
      version: args.version,
      installRoot,
      preserved,
      restartRequired: args.skipExit ? false : true,
    };
  } finally {
    if (process.platform !== "win32" || args.skipExit || !windowsHelperSpawned) {
      fs.rmSync(staging, { recursive: true, force: true });
    }
  }
}

function performWindowsSelfUpdate(opts: {
  installRoot: string;
  extracted: string;
  preserve: string[];
  version: string;
}): {
  version: string;
  installRoot: string;
  preserved: string[];
  restartRequired: boolean;
} {
  const helperScript = path.join(opts.extracted, "deploy", "windows", "apply-self-update.ps1");
  if (!fs.existsSync(helperScript)) {
    throw new Error(
      "update_helper_missing: deploy/windows/apply-self-update.ps1 not found in release package",
    );
  }

  const preserveArgs = opts.preserve.flatMap((name) => ["-Preserve", name]);
  const args = [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    helperScript,
    "-SourceDir",
    opts.extracted,
    "-TargetDir",
    opts.installRoot,
    "-AgentPid",
    String(process.pid),
    ...preserveArgs,
  ];

  const child = spawn("powershell.exe", args, {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();

  return {
    version: opts.version,
    installRoot: opts.installRoot,
    preserved: opts.preserve,
    restartRequired: true,
  };
}
