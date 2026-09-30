/**
 * experiences.* package build/validate helpers (#995).
 * Export packs mods + overlays + panel copy into a zip; install targets an
 * *existing* bound server (confirm + snapshot) — never creates a sibling.
 */
import { strFromU8, unzipSync, zipSync } from "fflate";
import {
  ExperienceManifestSchema,
  PLAYON_EXPERIENCE_JSON,
  assertExperienceName,
  type ExperienceManifest,
} from "@playon/shared";
import { checkPzLuaSources } from "./mods-lua-check.js";

const SECRET_RE =
  /(?:rcon[_-]?password|api[_-]?key|secret|token)\s*[:=]\s*["']?[^\s"']+/i;
const DENY_EXT = [".dll", ".so", ".dylib", ".exe", ".sys", ".asi"];

export type ExperienceLintFinding = {
  severity: "error" | "warn";
  rule: string;
  message: string;
  path?: string;
};

export class ExperiencePackageError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly findings?: ExperienceLintFinding[],
  ) {
    super(message);
    this.name = "ExperiencePackageError";
  }
}

export function lintExperienceManifest(
  manifest: ExperienceManifest,
  files: Record<string, string>,
): ExperienceLintFinding[] {
  const findings: ExperienceLintFinding[] = [];
  try {
    assertExperienceName(manifest.name);
  } catch (err) {
    findings.push({
      severity: "error",
      rule: "name",
      message: err instanceof Error ? err.message : String(err),
    });
  }
  if (!manifest.baseGame.startsWith("games.")) {
    findings.push({
      severity: "warn",
      rule: "baseGame",
      message: "baseGame should usually be a games.* skill name",
    });
  }
  if (manifest.mods.length === 0 && manifest.overlays.length === 0) {
    findings.push({
      severity: "error",
      rule: "empty_pack",
      message: "experience must include at least one mod or overlay",
    });
  }
  for (const [rel, content] of Object.entries(files)) {
    const lower = rel.toLowerCase();
    if (DENY_EXT.some((ext) => lower.endsWith(ext))) {
      findings.push({
        severity: "error",
        rule: "deny_native",
        message: `native/binary extension not allowed in experiences: ${rel}`,
        path: rel,
      });
    }
    if (SECRET_RE.test(content)) {
      findings.push({
        severity: "error",
        rule: "secrets",
        message: `possible secret material in ${rel}`,
        path: rel,
      });
    }
  }
  const luaFiles: Record<string, string> = {};
  for (const [rel, content] of Object.entries(files)) {
    if (rel.toLowerCase().endsWith(".lua")) luaFiles[rel] = content;
  }
  if (Object.keys(luaFiles).length > 0) {
    const check = checkPzLuaSources(luaFiles);
    for (const f of check.findings.filter((x) => x.severity === "error")) {
      findings.push({
        severity: "error",
        rule: `lua:${f.rule}`,
        message: f.message,
        path: f.file,
      });
    }
  }
  return findings;
}

export function buildExperienceZip(opts: {
  manifest: ExperienceManifest;
  files: Record<string, string>;
}): { filename: string; bytes: Uint8Array; findings: ExperienceLintFinding[] } {
  const manifest = ExperienceManifestSchema.parse(opts.manifest);
  const findings = lintExperienceManifest(manifest, opts.files);
  if (findings.some((f) => f.severity === "error")) {
    throw new ExperiencePackageError("experience_lint_failed", "experience_lint_failed", findings);
  }
  const zipFiles: Record<string, Uint8Array> = {
    [PLAYON_EXPERIENCE_JSON]: new TextEncoder().encode(`${JSON.stringify(manifest, null, 2)}\n`),
  };
  for (const [rel, content] of Object.entries(opts.files)) {
    const safe = rel.replace(/\\/g, "/").replace(/^\/+/, "");
    if (!safe || safe.includes("..")) {
      throw new ExperiencePackageError(`unsafe_path: ${rel}`, "unsafe_path");
    }
    zipFiles[safe] = new TextEncoder().encode(content);
  }
  const bytes = zipSync(zipFiles, { level: 6 });
  const slug = manifest.name.replace(/^experiences\./, "");
  return {
    filename: `${slug}-${manifest.version}.experience.zip`,
    bytes,
    findings,
  };
}

export function parseExperienceZip(zipBytes: Uint8Array): {
  manifest: ExperienceManifest;
  files: Record<string, string>;
  findings: ExperienceLintFinding[];
} {
  const unzipped = unzipSync(zipBytes);
  const keys = Object.keys(unzipped).map((k) => k.replace(/\\/g, "/"));
  const metaKey =
    keys.find((k) => k === PLAYON_EXPERIENCE_JSON) ??
    keys.find((k) => /^[^/]+\/playon-experience\.json$/.test(k));
  if (!metaKey) {
    throw new ExperiencePackageError("missing_playon_experience_json", "missing_manifest");
  }
  const rootPrefix = metaKey.includes("/") ? metaKey.slice(0, metaKey.indexOf("/")) : "";
  const normalized: Record<string, string> = {};
  let manifestRaw = "";
  for (const [entry, data] of Object.entries(unzipped)) {
    const safe = entry.replace(/\\/g, "/").replace(/^\/+/, "");
    if (!safe || safe.endsWith("/")) continue;
    const rel =
      rootPrefix && (safe === rootPrefix || safe.startsWith(`${rootPrefix}/`))
        ? safe.slice(rootPrefix.length).replace(/^\//, "")
        : safe;
    if (!rel) continue;
    if (rel === PLAYON_EXPERIENCE_JSON) {
      manifestRaw = strFromU8(data);
      continue;
    }
    normalized[rel] = strFromU8(data);
  }
  const manifest = ExperienceManifestSchema.parse(JSON.parse(manifestRaw || "{}"));
  const findings = lintExperienceManifest(manifest, normalized);
  return { manifest, files: normalized, findings };
}

export function planExperienceInstall(opts: {
  manifest: ExperienceManifest;
  files: Record<string, string>;
}): {
  modIds: string[];
  overlayPaths: string[];
  seedPaths: string[];
  panelSummary?: string;
} {
  return {
    modIds: opts.manifest.mods.map((m) => m.modId),
    overlayPaths: opts.manifest.overlays.map((o) => o.path),
    seedPaths: Object.keys(opts.files).filter((p) => p.startsWith("seed/")),
    panelSummary: opts.manifest.panel?.summary,
  };
}
