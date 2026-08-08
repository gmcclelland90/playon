/**
 * Allowlisted shallow scan for existing game server trees (Map import suggest).
 * Node-only — import from `@playon/shared/import-probe-walk`, not the browser bundle.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  ImportHintRule,
  ImportProbeCandidate,
  ManageProbeArgs,
  ManageProbeResult,
} from "./node-jobs/manage.js";

function expandHome(raw: string): string {
  let s = raw.trim();
  if (!s) return s;
  if (s.startsWith("~")) {
    s = path.join(os.homedir(), s.slice(1).replace(/^[\\/]/, ""));
  }
  s = s.replace(/%USERPROFILE%/gi, os.homedir());
  s = s.replace(/\$HOME\b/g, os.homedir());
  s = s.replace(/%USERNAME%/gi, os.userInfo().username);
  return path.normalize(s);
}

function globSegToRegExp(seg: string): RegExp {
  const escaped = seg.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`, "i");
}

function walkGlobParts(bases: string[], parts: string[]): string[] {
  let current = bases.map((b) => path.resolve(b));
  for (const part of parts) {
    const next: string[] = [];
    for (const base of current) {
      if (!part.includes("*")) {
        next.push(path.join(base, part));
        continue;
      }
      try {
        if (!fs.existsSync(base) || !fs.statSync(base).isDirectory()) continue;
      } catch {
        continue;
      }
      const re = globSegToRegExp(part);
      for (const name of fs.readdirSync(base)) {
        if (!re.test(name)) continue;
        next.push(path.join(base, name));
      }
    }
    current = next;
  }
  return current;
}

function expandGlobPattern(pattern: string): string[] {
  const normalized = path.normalize(expandHome(pattern));
  if (!normalized.includes("*")) return [normalized];

  if (process.platform === "win32" && /^[A-Za-z]:/.test(normalized)) {
    const root = path.parse(normalized).root;
    const rest = normalized.slice(root.length).split(path.sep).filter(Boolean);
    return walkGlobParts([root], rest);
  }

  const posix = normalized.replace(/\\/g, "/");
  if (posix.startsWith("/")) {
    return walkGlobParts(["/"], posix.split("/").filter(Boolean));
  }
  return walkGlobParts([process.cwd()], posix.split("/").filter(Boolean));
}

/** Expand root patterns (~, globs) into concrete directories that exist. */
export function expandScanRoots(patterns: string[]): string[] {
  const out = new Set<string>();
  for (const pattern of patterns) {
    for (const candidate of expandGlobPattern(pattern)) {
      try {
        if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
          out.add(path.resolve(candidate));
        }
      } catch {
        /* ignore */
      }
    }
  }
  return [...out];
}

function sourceHasAnyFile(sourcePath: string, relPaths: string[]): boolean {
  for (const rel of relPaths) {
    const abs = path.join(sourcePath, ...rel.split(/[/\\]/).filter(Boolean));
    try {
      if (fs.existsSync(abs)) return true;
    } catch {
      /* ignore */
    }
  }
  return false;
}

export function matchHintsAt(
  sourcePath: string,
  hints: ImportHintRule[],
): ImportProbeCandidate | null {
  for (const rule of hints) {
    if (!sourceHasAnyFile(sourcePath, rule.anyFiles)) continue;
    return {
      path: path.resolve(sourcePath),
      hintIds: [rule.id],
      suggestedGame: rule.suggestedGame,
      suggestedSkillName: rule.suggestedSkillName,
    };
  }
  return null;
}

export function isUnderAllowRoot(absPath: string, allowRoots: string[]): boolean {
  const resolved = path.resolve(absPath);
  for (const root of allowRoots) {
    const r = path.resolve(root);
    if (resolved === r || resolved.startsWith(r + path.sep)) return true;
  }
  return false;
}

/** Shallow walk allowlisted roots and fingerprint directories. */
export function runImportProbe(args: ManageProbeArgs): ManageProbeResult {
  const scannedRoots = expandScanRoots(args.roots);
  const candidates: ImportProbeCandidate[] = [];
  const seen = new Set<string>();

  const visit = (dir: string, depth: number) => {
    if (candidates.length >= args.maxCandidates) return;
    const resolved = path.resolve(dir);
    if (!isUnderAllowRoot(resolved, scannedRoots)) return;

    const hit = matchHintsAt(resolved, args.hints);
    if (hit && !seen.has(hit.path)) {
      seen.add(hit.path);
      candidates.push(hit);
      if (candidates.length >= args.maxCandidates) return;
    }
    if (depth >= args.maxDepth) return;

    let entries: string[];
    try {
      entries = fs.readdirSync(resolved);
    } catch {
      return;
    }
    for (const name of entries) {
      if (name.startsWith(".")) continue;
      const child = path.join(resolved, name);
      try {
        if (!fs.statSync(child).isDirectory()) continue;
      } catch {
        continue;
      }
      visit(child, depth + 1);
      if (candidates.length >= args.maxCandidates) return;
    }
  };

  for (const root of scannedRoots) {
    visit(root, 0);
  }

  return { candidates, scannedRoots };
}

export function assertPackPathAllowed(absPath: string, allowRoots: string[]): string {
  const resolved = path.resolve(absPath);
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
    throw new Error(`source_not_directory: ${resolved}`);
  }
  const expanded = expandScanRoots(allowRoots);
  const allowed =
    expanded.length > 0 ? expanded : allowRoots.map((r) => path.resolve(expandHome(r)));
  if (!isUnderAllowRoot(resolved, allowed)) {
    throw new Error(`path_not_allowlisted: ${resolved}`);
  }
  return resolved;
}
