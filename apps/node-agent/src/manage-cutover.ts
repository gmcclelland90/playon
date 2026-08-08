/**
 * manage_cutover: sniff systemd for an install, copy external userdata into servers/<id>/home.
 */
import { execFile, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { resolveInJail } from "@playon/runtime";
import {
  parseNodeJobArgs,
  parseNodeJobResult,
  type ImportHintManage,
  type ManageCutoverArgs,
  type ManageCutoverResult,
} from "@playon/shared";
import { assertPackPathAllowed } from "./import-probe.js";

const execFileAsync = promisify(execFile);

const DEFAULT_UNIT_DIRS = ["/etc/systemd/system", "/lib/systemd/system", "/usr/lib/systemd/system"];

export type ParsedSystemdUnit = {
  unitName: string;
  workingDirectory?: string;
  execStart?: string;
  user?: string;
};

/** Parse key fields from a systemd unit file body. */
export function parseSystemdUnit(unitName: string, body: string): ParsedSystemdUnit {
  const out: ParsedSystemdUnit = { unitName };
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    // Strip systemd specifiers / wrappers loosely.
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (key === "WorkingDirectory") out.workingDirectory = val;
    else if (key === "ExecStart") out.execStart = val;
    else if (key === "User") out.user = val;
  }
  return out;
}

/** Extract `-arg` / `--arg` / `+arg` values from an ExecStart line. */
export function parseCliArg(execStart: string | undefined, argName: string): string | undefined {
  if (!execStart || !argName) return undefined;
  const name = argName.replace(/^[-+]+/, "");
  const tokens = execStart.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [];
  for (let i = 0; i < tokens.length; i++) {
    const t = stripQuotes(tokens[i]!);
    if (t === `-${name}` || t === `--${name}` || t === `+${name}`) {
      const next = tokens[i + 1];
      if (next && !/^[-+]/.test(stripQuotes(next))) return stripQuotes(next);
    }
    for (const prefix of [`--${name}=`, `-${name}=`, `+${name}=`]) {
      if (t.startsWith(prefix)) return stripQuotes(t.slice(prefix.length));
    }
  }
  return undefined;
}

/** Basename used for world-selective copy (strips path + common save extensions). */
export function normalizeWorldKey(raw: string | undefined): string | undefined {
  if (!raw?.trim()) return undefined;
  let s = path.basename(raw.trim());
  s = s.replace(/\.(wld|zip|db|fwl|sav|old|bak)$/i, "");
  return s || undefined;
}

/** Remap an absolute launch path under the old user home into PLAYON_HOME userdata. */
export function remapLaunchValue(
  raw: string | undefined,
  playonHome: string | undefined,
  userdataHomeDirs: string[],
): string | undefined {
  if (!raw) return undefined;
  if (!playonHome) return raw;
  const norm = raw.replace(/\\/g, "/");
  if (!norm.includes("/")) return raw;
  for (const dir of userdataHomeDirs) {
    const marker = dir.replace(/\\/g, "/").replace(/^\.\//, "");
    const idx = norm.toLowerCase().indexOf("/" + marker.toLowerCase());
    const idx0 = norm.toLowerCase().indexOf(marker.toLowerCase());
    const at = idx >= 0 ? idx + 1 : idx0 === 0 ? 0 : -1;
    if (at < 0) continue;
    const rest = norm.slice(at + marker.length).replace(/^\//, "");
    return path.join(playonHome, ...marker.split("/"), ...(rest ? rest.split("/") : []));
  }
  return raw;
}

function stripQuotes(s: string): string {
  if (
    (s.startsWith('"') && s.endsWith('"')) ||
    (s.startsWith("'") && s.endsWith("'"))
  ) {
    return s.slice(1, -1);
  }
  return s;
}

export function unitReferencesInstall(unit: ParsedSystemdUnit, installPath: string): boolean {
  const resolved = path.resolve(installPath);
  const wd = unit.workingDirectory ? path.resolve(unit.workingDirectory) : "";
  const exec = unit.execStart ?? "";
  if (wd && (wd === resolved || wd.startsWith(resolved + path.sep))) return true;
  // ExecStart may contain the install path as cwd-relative or absolute.
  if (exec.includes(resolved)) return true;
  // Also match when WorkingDirectory is the install and ExecStart is relative.
  if (wd === resolved) return true;
  return false;
}

/** Read systemd units that reference the install path. */
export function findUnitsForInstall(
  installPath: string,
  unitDirs: string[] = DEFAULT_UNIT_DIRS,
): ParsedSystemdUnit[] {
  const matches: ParsedSystemdUnit[] = [];
  for (const dir of unitDirs) {
    if (!fs.existsSync(dir)) continue;
    let names: string[];
    try {
      names = fs.readdirSync(dir).filter((n) => n.endsWith(".service"));
    } catch {
      continue;
    }
    for (const name of names) {
      try {
        const body = fs.readFileSync(path.join(dir, name), "utf8");
        const parsed = parseSystemdUnit(name, body);
        if (unitReferencesInstall(parsed, installPath)) matches.push(parsed);
      } catch {
        /* skip unreadable */
      }
    }
  }
  return matches;
}

/** Resolve the Unix home that owns userdata for this install (unit User or path heuristic). */
export function resolveServiceHome(unitUser: string | undefined, installPath: string): string | null {
  const existing = (home: string | null | undefined): string | null =>
    home && fs.existsSync(home) ? home : null;

  if (unitUser && unitUser !== "root") {
    let fromGetent: string | undefined;
    try {
      fromGetent = execFileSync("getent", ["passwd", unitUser], { encoding: "utf8" }).split(":")[5];
    } catch {
      /* ignore */
    }
    const hit = existing(fromGetent) || existing(path.join("/home", unitUser));
    if (hit) return hit;
  }

  // Ascend from install: .../home/<user>/...
  let cur = path.resolve(installPath);
  for (;;) {
    const parent = path.dirname(cur);
    if (parent === cur) break;
    if (path.basename(parent).toLowerCase() === "home") {
      return existing(cur);
    }
    cur = parent;
  }
  return null;
}

/** Which files/dirs under a userdata tree belong to one named world. */
export function worldSelectiveSources(
  userdataRoot: string,
  serverName: string,
  worldSubdirs: string[],
): string[] {
  const out: string[] = [];
  for (const sub of worldSubdirs) {
    const base = path.join(userdataRoot, ...sub.split("/"));
    if (!fs.existsSync(base)) continue;
    const st = fs.statSync(base);
    if (!st.isDirectory()) continue;
    if (sub.replace(/\\/g, "/").endsWith("Saves/Multiplayer") || sub === "Saves/Multiplayer") {
      const worldDir = path.join(base, serverName);
      if (fs.existsSync(worldDir) && fs.statSync(worldDir).isDirectory()) out.push(worldDir);
      continue;
    }
    for (const name of fs.readdirSync(base)) {
      if (name === serverName || name.startsWith(`${serverName}.`) || name.startsWith(`${serverName}_`)) {
        out.push(path.join(base, name));
      }
    }
  }
  return out;
}

async function copyPathAsync(src: string, dest: string): Promise<void> {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  if (process.platform === "win32") {
    await new Promise<void>((resolve, reject) => {
      fs.cp(src, dest, { recursive: true }, (err) => (err ? reject(err) : resolve()));
    });
    return;
  }
  const st = fs.statSync(src);
  if (st.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true });
    await execFileAsync("cp", ["-a", `${src}/.`, dest], { maxBuffer: 16 * 1024 * 1024 });
  } else {
    await execFileAsync("cp", ["-a", src, dest], { maxBuffer: 16 * 1024 * 1024 });
  }
}

function approxBytes(p: string): number {
  try {
    const out = execFileSync("du", ["-sb", p], { encoding: "utf8" });
    const n = Number(out.trim().split(/\s+/)[0]);
    if (Number.isFinite(n) && n >= 0) return n;
  } catch {
    /* walk */
  }
  let total = 0;
  const walk = (dir: string) => {
    for (const name of fs.readdirSync(dir)) {
      const abs = path.join(dir, name);
      const st = fs.statSync(abs);
      if (st.isDirectory()) walk(abs);
      else total += st.size;
    }
  };
  try {
    const st = fs.statSync(p);
    if (st.isFile()) return st.size;
    walk(p);
  } catch {
    return 0;
  }
  return total;
}

export async function runManageCutover(
  rawArgs: ManageCutoverArgs,
  dataRoot: string,
  opts?: { unitDirs?: string[] },
): Promise<ManageCutoverResult> {
  // The contract pins homeRel to servers/<id>/home; the jail is the backstop.
  const args = parseNodeJobArgs("manage_cutover", rawArgs);
  const source = assertPackPathAllowed(args.sourcePath, args.allowRoots);

  const playonHome = resolveInJail(dataRoot, args.homeRel);
  const warnings: string[] = [];

  if (process.platform === "win32") {
    fs.mkdirSync(playonHome, { recursive: true });
    warnings.push("manage_cutover_windows_skip: systemd/userdata cutover is Linux-only");
    return parseNodeJobResult("manage_cutover", {
      playonHome,
      playonHomeRel: args.homeRel.split(path.sep).join("/"),
      userdataBytes: 0,
      warnings,
    });
  }

  fs.mkdirSync(playonHome, { recursive: true });

  const manage: ImportHintManage = args.manage;
  const units = findUnitsForInstall(source, opts?.unitDirs);
  const unit = units[0];
  if (units.length > 1) {
    warnings.push(`multiple_systemd_units:${units.map((u) => u.unitName).join(",")}`);
  }

  const rawServerName = manage.serverNameArg
    ? parseCliArg(unit?.execStart, manage.serverNameArg)
    : undefined;
  const worldKey = normalizeWorldKey(rawServerName);
  const launchServerName = remapLaunchValue(rawServerName, playonHome, manage.userdataHomeDirs);

  const serviceHome = resolveServiceHome(unit?.user, source);
  let userdataBytes = 0;

  if (!manage.userdataHomeDirs.length) {
    // Install-local games (Rust identity, Minecraft world/) — seed already covers data.
  } else if (!serviceHome) {
    warnings.push("userdata_home_unresolved");
  } else {
    for (const dirName of manage.userdataHomeDirs) {
      const userdataRoot = path.join(serviceHome, ...dirName.split("/"));
      if (!fs.existsSync(userdataRoot) || !fs.statSync(userdataRoot).isDirectory()) {
        warnings.push(`userdata_missing:${userdataRoot}`);
        continue;
      }
      const destRoot = path.join(playonHome, ...dirName.split("/"));
      fs.mkdirSync(destRoot, { recursive: true });

      try {
        if (worldKey) {
          const sources = worldSelectiveSources(userdataRoot, worldKey, manage.worldSubdirs);
          if (!sources.length) {
            warnings.push(`world_files_missing:${worldKey}`);
            await copyPathAsync(userdataRoot, destRoot);
          } else {
            for (const src of sources) {
              const rel = path.relative(userdataRoot, src);
              const dest = path.join(destRoot, rel);
              await copyPathAsync(src, dest);
            }
          }
        } else {
          warnings.push("servername_unknown_copying_full_userdata");
          await copyPathAsync(userdataRoot, destRoot);
        }
        userdataBytes += approxBytes(destRoot);
      } catch (err) {
        const code = (err as NodeJS.ErrnoException)?.code;
        const msg = err instanceof Error ? err.message : String(err);
        if (code === "EACCES" || /permission denied/i.test(msg)) {
          warnings.push(`userdata_unreadable:${userdataRoot}`);
        } else {
          warnings.push(`userdata_copy_failed:${msg}`);
        }
      }
    }
  }

  if (!unit) warnings.push("no_systemd_unit_for_install");

  return parseNodeJobResult("manage_cutover", {
    // Prefer remapped launch path when present; else world key / raw identity.
    serverName: launchServerName || worldKey || rawServerName || undefined,
    unitName: unit?.unitName,
    playonHome,
    playonHomeRel: args.homeRel.split(path.sep).join("/"),
    userdataBytes,
    warnings,
  });
}
