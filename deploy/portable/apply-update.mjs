#!/usr/bin/env node
/**
 * Apply a staged PlayOn Home or Node package over an install root.
 * Runs outside the tree being replaced (caller copies this script to a temp dir).
 *
 * Usage:
 *   node apply-update.mjs --target <installRoot> --source <extractedTree> \
 *     [--preserve data,env,apps/api/data] [--mode portable|service] [--kind home|node] \
 *     [--relaunch <cmd>] [--swap-only]
 */
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

function parseArgs(argv) {
  const out = {
    target: "",
    source: "",
    preserve: ["data", "env", "node.env", "node.env.cmd"],
    mode: "portable",
    kind: "home",
    relaunch: "",
    swapOnly: false,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    const next = argv[i + 1];
    if (a === "--target" && next) {
      out.target = path.resolve(next);
      i++;
    } else if (a === "--source" && next) {
      out.source = path.resolve(next);
      i++;
    } else if (a === "--preserve" && next) {
      out.preserve = next.split(",").map((s) => s.trim()).filter(Boolean);
      i++;
    } else if (a === "--mode" && next) {
      out.mode = next;
      i++;
    } else if (a === "--kind" && next) {
      out.kind = next;
      i++;
    } else if (a === "--relaunch" && next) {
      out.relaunch = next;
      i++;
    } else if (a === "--swap-only") {
      out.swapOnly = true;
    }
  }
  return out;
}

function copyTree(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name);
    const dest = path.join(to, entry.name);
    // pnpm workspace packages ship as symlinks; follow Dirent, not stat().
    if (entry.isSymbolicLink()) {
      const link = fs.readlinkSync(src);
      try {
        fs.symlinkSync(link, dest);
      } catch (err) {
        if (/** @type {NodeJS.ErrnoException} */ (err).code === "EEXIST") {
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

function normalizePreserveEntry(entry) {
  return String(entry || "")
    .replace(/\\/g, "/")
    .replace(/^\/+|\/+$/g, "");
}

function movePath(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  try {
    fs.renameSync(from, to);
  } catch {
    copyTree(from, to);
    fs.rmSync(from, { recursive: true, force: true });
  }
}

/**
 * Swap source → target, keeping preserve names/paths that already exist on target.
 * Preserve entries may be top-level (`data`) or nested (`apps/api/data`).
 */
export function swapInstallTree(opts) {
  const target = path.resolve(opts.target);
  const source = path.resolve(opts.source);
  const preserveRaw = (opts.preserve ?? ["data", "env"]).map(normalizePreserveEntry).filter(Boolean);

  if (!fs.existsSync(source)) throw new Error(`update_source_missing: ${source}`);
  if (!fs.existsSync(path.join(source, "package.json")) && !fs.existsSync(path.join(source, "apps"))) {
    throw new Error(`update_source_invalid: ${source}`);
  }

  // Refuse to use a source that lives inside the target tree — replacing e.g. `apps/`
  // would delete the staged package mid-copy (common when staging under apps/api/data).
  const relSource = path.relative(target, source);
  if (relSource && !relSource.startsWith("..") && !path.isAbsolute(relSource)) {
    throw new Error(`update_source_inside_target: ${source}`);
  }

  const topLevel = new Set();
  const nested = [];
  for (const entry of preserveRaw) {
    if (entry.includes("..")) continue;
    if (entry.includes("/")) nested.push(entry);
    else topLevel.add(entry);
  }

  const parked = [];
  for (const rel of nested) {
    const abs = path.join(target, ...rel.split("/"));
    if (!fs.existsSync(abs)) continue;
    const parkRoot = fs.mkdtempSync(path.join(os.tmpdir(), "playon-preserve-"));
    const parkPath = path.join(parkRoot, "payload");
    movePath(abs, parkPath);
    parked.push({ rel, parkPath, parkRoot });
  }

  fs.mkdirSync(target, { recursive: true });
  const sourceNames = new Set(fs.readdirSync(source));
  for (const name of fs.readdirSync(target)) {
    if (topLevel.has(name)) continue;
    if (!sourceNames.has(name)) {
      fs.rmSync(path.join(target, name), { recursive: true, force: true });
    }
  }
  const entries = fs.readdirSync(source, { withFileTypes: true });
  for (const entry of entries) {
    const name = entry.name;
    const dest = path.join(target, name);
    if (topLevel.has(name) && fs.existsSync(dest)) continue;
    fs.rmSync(dest, { recursive: true, force: true });
    const src = path.join(source, name);
    if (entry.isDirectory()) copyTree(src, dest);
    else fs.copyFileSync(src, dest);
  }

  for (const item of parked) {
    const abs = path.join(target, ...item.rel.split("/"));
    fs.rmSync(abs, { recursive: true, force: true });
    movePath(item.parkPath, abs);
    fs.rmSync(item.parkRoot, { recursive: true, force: true });
  }

  const preserved = [
    ...[...topLevel].filter((n) => fs.existsSync(path.join(target, n))),
    ...nested.filter((rel) => fs.existsSync(path.join(target, ...rel.split("/")))),
  ];
  return { target, preserved };
}

function stopService(kind) {
  const isWin = process.platform === "win32";
  if (isWin) {
    const tasks =
      kind === "node"
        ? ["PlayOnNodeAgent"]
        : ["PlayOnControlPlane", "PlayOnLocalNode"];
    for (const name of tasks) {
      try {
        execFileSync(
          "powershell.exe",
          [
            "-NoProfile",
            "-Command",
            `Stop-ScheduledTask -TaskName '${name}' -ErrorAction SilentlyContinue`,
          ],
          { stdio: "ignore" },
        );
      } catch {
        // task may not exist / access denied
      }
    }
    return;
  }
  const units = kind === "node" ? ["playon-node-agent"] : ["playon", "playon-node"];
  for (const u of units) {
    try {
      execFileSync("systemctl", ["stop", `${u}.service`], { stdio: "ignore" });
    } catch {
      // unit may not exist, or polkit may deny stop from the service user
    }
  }
}

function startService(kind) {
  const isWin = process.platform === "win32";
  if (isWin) {
    const tasks =
      kind === "node"
        ? ["PlayOnNodeAgent"]
        : ["PlayOnControlPlane", "PlayOnLocalNode"];
    for (const name of tasks) {
      try {
        execFileSync(
          "powershell.exe",
          ["-NoProfile", "-Command", `Start-ScheduledTask -TaskName '${name}'`],
          { stdio: "ignore" },
        );
      } catch {
        // task may not exist in portable mode
      }
    }
    return;
  }
  const units = kind === "node" ? ["playon-node-agent"] : ["playon", "playon-node"];
  for (const u of units) {
    try {
      execFileSync("systemctl", ["start", `${u}.service`], { stdio: "ignore" });
    } catch {
      // unit may not exist / access denied — Restart=always may still bring Home back
    }
  }
}

function relaunchPortable(target, kind, relaunchCmd) {
  const isWin = process.platform === "win32";
  if (relaunchCmd) {
    spawn(relaunchCmd, {
      cwd: target,
      detached: true,
      stdio: "ignore",
      shell: true,
    }).unref();
    return;
  }
  if (kind === "node") {
    const script = isWin
      ? path.join(target, "start-node.ps1")
      : path.join(target, "start-node.sh");
    if (fs.existsSync(script)) {
      if (isWin) {
        spawn("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script], {
          cwd: target,
          detached: true,
          stdio: "ignore",
        }).unref();
      } else {
        spawn(script, [], { cwd: target, detached: true, stdio: "ignore" }).unref();
      }
    }
    return;
  }
  if (isWin) {
    const ps1 = path.join(target, "Start-PlayOn.ps1");
    spawn("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", ps1], {
      cwd: target,
      detached: true,
      stdio: "ignore",
    }).unref();
  } else {
    const sh = path.join(target, "start-playon.sh");
    spawn(sh, [], { cwd: target, detached: true, stdio: "ignore" }).unref();
  }
}

const invokedAsCli =
  process.argv[1] &&
  path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1]);

if (invokedAsCli) {
  const args = parseArgs(process.argv);
  if (!args.target || !args.source) {
    console.error(
      "Usage: node apply-update.mjs --target <dir> --source <extracted> [--mode portable|service] [--kind home|node] [--swap-only]",
    );
    process.exit(2);
  }

  const logFile = path.join(os.tmpdir(), `playon-apply-update-${process.pid}.log`);
  const log = (line) => {
    const msg = `[playon-apply] ${line}`;
    console.log(msg);
    try {
      fs.appendFileSync(logFile, `${msg}\n`);
    } catch {
      // ignore
    }
  };

  try {
    // On Windows, wait so the parent can exit and release file locks.
    // On Linux/macOS, callers typically use --swap-only while the parent is still alive.
    if (process.platform === "win32" && !args.swapOnly) {
      await new Promise((r) => setTimeout(r, 1500));
    }

    if (args.mode === "service" && !args.swapOnly) {
      log(`Stopping services (${args.kind})…`);
      stopService(args.kind);
      await new Promise((r) => setTimeout(r, 500));
    }

    log(`Applying update → ${args.target}`);
    const result = swapInstallTree(args);
    log(`Preserved: ${result.preserved.join(", ") || "(none)"}`);

    if (!args.swapOnly) {
      if (args.mode === "service") {
        log("Starting services…");
        startService(args.kind);
      } else {
        log("Relaunching portable…");
        relaunchPortable(args.target, args.kind, args.relaunch);
      }
    }
    log(`Update applied (log: ${logFile})`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log(`FAILED: ${message}`);
    console.error(message);
    process.exit(1);
  }
}
