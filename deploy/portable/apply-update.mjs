#!/usr/bin/env node
/**
 * Apply a staged PlayOn Home or Node package over an install root.
 * Runs outside the tree being replaced (caller copies this script to a temp dir).
 *
 * Usage:
 *   node apply-update.mjs --target <installRoot> --source <extractedTree> \
 *     [--preserve data,env] [--mode portable|service] [--kind home|node] [--relaunch <cmd>]
 */
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
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
    }
  }
  return out;
}

function copyTree(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name);
    const dest = path.join(to, entry.name);
    if (entry.isDirectory()) copyTree(src, dest);
    else fs.copyFileSync(src, dest);
  }
}

/** Swap source → target, keeping preserve names that already exist on target. */
export function swapInstallTree(opts) {
  const target = path.resolve(opts.target);
  const source = path.resolve(opts.source);
  const preserve = new Set(opts.preserve ?? ["data", "env"]);

  if (!fs.existsSync(source)) throw new Error(`update_source_missing: ${source}`);
  if (!fs.existsSync(path.join(source, "package.json")) && !fs.existsSync(path.join(source, "apps"))) {
    throw new Error(`update_source_invalid: ${source}`);
  }

  fs.mkdirSync(target, { recursive: true });
  const sourceNames = new Set(fs.readdirSync(source));
  for (const name of fs.readdirSync(target)) {
    if (preserve.has(name)) continue;
    if (!sourceNames.has(name)) {
      fs.rmSync(path.join(target, name), { recursive: true, force: true });
    }
  }
  const entries = fs.readdirSync(source, { withFileTypes: true });
  for (const entry of entries) {
    const name = entry.name;
    const dest = path.join(target, name);
    if (preserve.has(name) && fs.existsSync(dest)) continue;
    fs.rmSync(dest, { recursive: true, force: true });
    const src = path.join(source, name);
    if (entry.isDirectory()) copyTree(src, dest);
    else fs.copyFileSync(src, dest);
  }
  return { target, preserved: [...preserve].filter((n) => fs.existsSync(path.join(target, n))) };
}

function restartService(kind) {
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
      execFileSync("systemctl", ["restart", `${u}.service`], { stdio: "ignore" });
    } catch {
      // unit may not exist in portable mode
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
      "Usage: node apply-update.mjs --target <dir> --source <extracted> [--mode portable|service] [--kind home|node]",
    );
    process.exit(2);
  }
  // Brief delay so the parent process can exit / release file locks.
  await new Promise((r) => setTimeout(r, 1500));
  console.log(`==> Applying update → ${args.target}`);
  const result = swapInstallTree(args);
  console.log(`==> Preserved: ${result.preserved.join(", ") || "(none)"}`);
  if (args.mode === "service") {
    restartService(args.kind);
  } else {
    relaunchPortable(args.target, args.kind, args.relaunch);
  }
  console.log("==> Update applied");
}
