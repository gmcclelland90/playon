import {
  INSTANCE_INI_HINT_DIRS,
  MODS_SRC_DIR,
  PLAYON_MOD_JSON,
  PlayonModManifestSchema,
  normalizePlayonModDialect,
  type ModClientNeed,
  type PlayonModDialect,
  type PlayonModManifest,
} from "@playon/shared";
import { ServerFileStoreError, type ServerFileStore } from "./server-file-store.js";

export const PRE_MOD_DEPLOY_LABEL = "pre-mod-deploy";

export type ModsWorkspaceErrorCode =
  | "invalid_id"
  | "path_escape"
  | "forbidden_dest"
  | "workspace_exists"
  | "workspace_not_found"
  | "playon_mod_json_missing"
  | "playon_mod_json_invalid"
  | "unknown_dialect"
  | "unsupported_dialect"
  | "io_failed";

export class ModsWorkspaceError extends Error {
  readonly code: ModsWorkspaceErrorCode;

  constructor(code: ModsWorkspaceErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = "ModsWorkspaceError";
    this.code = code;
  }
}

const MOD_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** Destinations deploy must never write (Workshop cache, worlds, db, player saves). */
const FORBIDDEN_DEST_PREFIXES = [
  "steamapps/workshop",
  "workshop/content",
  "worlds",
  "db",
  "saves",
  "player",
  "players",
  "zomboid/saves",
  "home/zomboid/saves",
] as const;

export function assertSafeModId(modId: string): string {
  const trimmed = modId.trim();
  if (!trimmed) {
    throw new ModsWorkspaceError("invalid_id", "invalid_id: empty");
  }
  if (
    trimmed.includes("..") ||
    trimmed.includes("/") ||
    trimmed.includes("\\") ||
    trimmed.startsWith("~")
  ) {
    throw new ModsWorkspaceError("path_escape", `path_escape: ${modId}`);
  }
  if (!MOD_ID_RE.test(trimmed)) {
    throw new ModsWorkspaceError("invalid_id", `invalid_id: ${modId}`);
  }
  return trimmed;
}

/** Jail-relative posix path. Rejects `..` and empty segments. */
export function jailRel(...parts: string[]): string {
  const joined = parts
    .flatMap((p) => p.replace(/\\/g, "/").split("/"))
    .filter((p) => p && p !== ".")
    .join("/");
  if (!joined) {
    throw new ModsWorkspaceError("path_escape", "path_escape: empty");
  }
  if (joined.split("/").some((p) => p === "..") || joined.startsWith("/")) {
    throw new ModsWorkspaceError("path_escape", `path_escape: ${joined}`);
  }
  return joined;
}

export function modsSrcRel(modId: string): string {
  return jailRel(MODS_SRC_DIR, assertSafeModId(modId));
}

export function assertAllowedDeployRel(rel: string): void {
  const norm = rel.replace(/\\/g, "/").replace(/^\/+/, "").toLowerCase();
  if (!norm || norm.split("/").some((p) => p === "..")) {
    throw new ModsWorkspaceError("path_escape", `path_escape: ${rel}`);
  }
  for (const prefix of FORBIDDEN_DEST_PREFIXES) {
    if (norm === prefix || norm.startsWith(`${prefix}/`)) {
      throw new ModsWorkspaceError("forbidden_dest", `forbidden_dest: ${rel}`);
    }
  }
}

export type DeployEnableKind = "pz_mods_ini" | "presence";

export type DialectLiveDest =
  | {
      ok: true;
      dialect: PlayonModDialect;
      destPath: string;
      enable: DeployEnableKind;
    }
  | { ok: false; error: "unknown_dialect" | "unsupported_dialect"; dialect: string };

/** v1 dest map under the File Store jail. PZ + Paper required; others stub. */
export function dialectLiveDest(dialect: string, modId: string): DialectLiveDest {
  const id = assertSafeModId(modId);
  const normalized = normalizePlayonModDialect(dialect) ?? dialect.trim().toLowerCase();
  if (normalized === "project-zomboid") {
    const destPath = jailRel("mods", id);
    assertAllowedDeployRel(destPath);
    return { ok: true, dialect: "project-zomboid", destPath, enable: "pz_mods_ini" };
  }
  if (normalized === "minecraft-paper") {
    assertAllowedDeployRel("plugins");
    return { ok: true, dialect: "minecraft-paper", destPath: "plugins", enable: "presence" };
  }
  if (
    normalized === "rust-oxide" ||
    normalized === "rust-carbon" ||
    normalized === "garrys-mod" ||
    normalized === "terraria-tmod" ||
    normalized === "factorio"
  ) {
    return { ok: false, error: "unsupported_dialect", dialect: normalized };
  }
  return { ok: false, error: "unknown_dialect", dialect: normalized || dialect };
}

/** Append `modFolder` to a PZ `Mods=` line (semicolon-separated). */
export function patchPzModsIni(content: string, modFolder: string): { text: string; changed: boolean } {
  const id = assertSafeModId(modFolder);
  const re = /^(\s*Mods\s*=\s*)(.*)$/im;
  const match = content.match(re);
  if (!match) {
    const suffix = !content || content.endsWith("\n") ? "" : "\n";
    return { text: `${content}${suffix}Mods=${id}\n`, changed: true };
  }
  const existing = match[2]!
    .split(/[;,]/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (existing.includes(id)) return { text: content, changed: false };
  const next = [...existing, id].join(";");
  return { text: content.replace(re, `$1${next}`), changed: true };
}

export type ScaffoldResult = {
  path: string;
  dialect: PlayonModDialect;
  created: string[];
  overwritten: boolean;
};

export type DeployMutateResult = {
  destPath: string;
  enablePatched: boolean;
  clientNeed: ModClientNeed;
  copied: number;
};

async function dirEntries(
  files: ServerFileStore,
  relPath: string,
): Promise<Array<{ name: string; type: "file" | "dir" }> | null> {
  try {
    return await files.list(relPath);
  } catch (err) {
    if (err instanceof ServerFileStoreError && err.code === "not_found") return null;
    throw err;
  }
}

async function walkFiles(files: ServerFileStore, relDir: string): Promise<string[]> {
  const entries = await dirEntries(files, relDir);
  if (!entries) return [];
  const out: string[] = [];
  for (const entry of entries) {
    const child = jailRel(relDir, entry.name);
    if (entry.type === "dir") {
      out.push(...(await walkFiles(files, child)));
    } else {
      out.push(child);
    }
  }
  return out;
}

const DEFAULT_CLIENT_NEED: ModClientNeed = "none";

function skeletonFiles(
  dialect: PlayonModDialect,
  modId: string,
  displayName: string,
): Record<string, string> {
  if (dialect === "project-zomboid") {
    return {
      "mod.info": [
        `name=${displayName}`,
        `id=${modId}`,
        "description=PlayOn-authored server-local mod (edit in mods-src, then mods_deploy).",
        "poster=",
        "",
      ].join("\n"),
      [`media/lua/server/${modId}.lua`]: [
        `-- PlayOn scaffold: ${displayName}`,
        `-- Server-side Lua. This file is not loaded until mods_deploy copies it to mods/${modId}/.`,
        "",
      ].join("\n"),
    };
  }
  if (dialect === "minecraft-paper") {
    return {
      "plugin.yml": [
        `name: ${displayName.replace(/[^\w .-]/g, "")}`,
        "main: com.playon.generated.Plugin",
        "version: 0.1.0",
        "api-version: '1.20'",
        "",
      ].join("\n"),
      "BUILD.md": [
        "# Paper plugin (v1)",
        "",
        "PlayOn does not compile Java in the jail. Place a built `.jar` in this folder",
        "(or keep this source tree as a documented drop), then confirm `mods_deploy`.",
        "Do not fetch random GitHub releases without `fetch_url` confirm.",
        "",
      ].join("\n"),
    };
  }
  return {
    "README.md": [
      `# ${displayName}`,
      "",
      `Dialect \`${dialect}\` is not deployable in v1 (unsupported_dialect).`,
      "Author files here; `mods_deploy` will refuse until a dest map lands.",
      "",
    ].join("\n"),
  };
}

export async function scaffoldModWorkspace(opts: {
  files: ServerFileStore;
  modId: string;
  dialect: string;
  displayName?: string;
  clientNeed?: ModClientNeed;
  version?: string;
  overwrite?: boolean;
}): Promise<ScaffoldResult> {
  const modId = assertSafeModId(opts.modId);
  const dialect = normalizePlayonModDialect(opts.dialect);
  if (!dialect) {
    throw new ModsWorkspaceError("unknown_dialect", `unknown_dialect: ${opts.dialect}`);
  }
  const src = modsSrcRel(modId);
  const existing = await dirEntries(opts.files, src);
  if (existing && existing.length > 0 && !opts.overwrite) {
    throw new ModsWorkspaceError("workspace_exists", `workspace_exists: ${src}`);
  }

  const displayName = (opts.displayName ?? modId).trim() || modId;
  const manifest: PlayonModManifest = PlayonModManifestSchema.parse({
    dialect,
    displayName,
    clientNeed: opts.clientNeed ?? DEFAULT_CLIENT_NEED,
    version: opts.version ?? "0.1.0",
  });

  await opts.files.ensureDir(src);
  const created: string[] = [];
  const writes: Record<string, string> = {
    [PLAYON_MOD_JSON]: `${JSON.stringify(manifest, null, 2)}\n`,
    ...skeletonFiles(dialect, modId, displayName),
  };
  for (const [rel, content] of Object.entries(writes)) {
    const dest = jailRel(src, rel);
    await opts.files.writeText(dest, content);
    created.push(dest);
  }
  return { path: src, dialect, created, overwritten: Boolean(opts.overwrite && existing?.length) };
}

export async function readPlayonModManifest(
  files: ServerFileStore,
  modId: string,
): Promise<PlayonModManifest> {
  const rel = jailRel(modsSrcRel(modId), PLAYON_MOD_JSON);
  try {
    const raw = await files.readText(rel);
    const parsed = PlayonModManifestSchema.safeParse(JSON.parse(raw.content));
    if (!parsed.success) {
      throw new ModsWorkspaceError("playon_mod_json_invalid", `playon_mod_json_invalid: ${rel}`);
    }
    return parsed.data;
  } catch (err) {
    if (err instanceof ModsWorkspaceError) throw err;
    if (err instanceof ServerFileStoreError && err.code === "not_found") {
      throw new ModsWorkspaceError("playon_mod_json_missing", `playon_mod_json_missing: ${rel}`);
    }
    if (err instanceof SyntaxError) {
      throw new ModsWorkspaceError("playon_mod_json_invalid", `playon_mod_json_invalid: ${rel}`);
    }
    throw err;
  }
}

async function findPzServerIni(files: ServerFileStore): Promise<string | null> {
  for (const dir of INSTANCE_INI_HINT_DIRS) {
    const entries = await dirEntries(files, dir);
    if (!entries) continue;
    const inis = entries.filter((e) => e.type === "file" && e.name.toLowerCase().endsWith(".ini"));
    let fallback: string | null = null;
    for (const ini of inis) {
      const rel = jailRel(dir, ini.name);
      try {
        const text = (await files.readText(rel)).content;
        if (/^\s*Mods\s*=/im.test(text)) return rel;
        fallback ??= rel;
      } catch {
        /* skip unreadable */
      }
    }
    if (fallback) return fallback;
  }
  return null;
}

async function copyWorkspaceMinusManifest(
  files: ServerFileStore,
  srcDir: string,
  destDir: string,
): Promise<number> {
  assertAllowedDeployRel(destDir);
  const all = await walkFiles(files, srcDir);
  let copied = 0;
  for (const src of all) {
    const relFromSrc = src.slice(srcDir.length).replace(/^\/+/, "");
    if (!relFromSrc || relFromSrc === PLAYON_MOD_JSON || relFromSrc.endsWith(`/${PLAYON_MOD_JSON}`)) {
      continue;
    }
    const dest = jailRel(destDir, relFromSrc);
    assertAllowedDeployRel(dest);
    const { data } = await files.readBytes(src);
    await files.writeBytes(dest, data);
    copied += 1;
  }
  return copied;
}

/**
 * Copy `mods-src/<modId>/` (minus playon-mod.json) into the dialect live path
 * and patch enable lists. Caller must wrap this with `withSnapshot` first.
 */
export async function mutateDeployMod(opts: {
  files: ServerFileStore;
  modId: string;
  dialect: string;
}): Promise<DeployMutateResult> {
  const modId = assertSafeModId(opts.modId);
  const src = modsSrcRel(modId);
  const listing = await dirEntries(opts.files, src);
  if (!listing) {
    throw new ModsWorkspaceError("workspace_not_found", `workspace_not_found: ${src}`);
  }

  const manifest = await readPlayonModManifest(opts.files, modId);
  const dialect = normalizePlayonModDialect(opts.dialect) ?? manifest.dialect;
  const dest = dialectLiveDest(dialect, modId);
  if (!dest.ok) {
    throw new ModsWorkspaceError(dest.error, `${dest.error}: ${dest.dialect}`);
  }

  await opts.files.ensureDir(dest.destPath);
  const copied = await copyWorkspaceMinusManifest(opts.files, src, dest.destPath);

  let enablePatched = dest.enable === "presence";
  if (dest.enable === "pz_mods_ini") {
    const iniRel = await findPzServerIni(opts.files);
    if (iniRel) {
      assertAllowedDeployRel(iniRel);
      const current = (await opts.files.readText(iniRel)).content;
      const patched = patchPzModsIni(current, modId);
      if (patched.changed) {
        await opts.files.writeText(iniRel, patched.text);
      }
      enablePatched = true;
    } else {
      enablePatched = false;
    }
  }

  return {
    destPath: dest.destPath,
    enablePatched,
    clientNeed: manifest.clientNeed,
    copied,
  };
}

/**
 * Snapshot-then-mutate deploy. `snapshotFirst` must run the snapshot (e.g.
 * `withSnapshot`) *before* invoking `fn`. Tests inject a recorder; the tool
 * wires `withSnapshot`.
 */
export async function deployAuthoredMod(opts: {
  files: ServerFileStore;
  modId: string;
  dialect: string;
  snapshotFirst: <T>(fn: () => Promise<T>) => Promise<T>;
}): Promise<DeployMutateResult> {
  // Validate workspace + manifest before snapshot so a refuse does not snapshot.
  const listing = await dirEntries(opts.files, modsSrcRel(opts.modId));
  if (!listing) {
    throw new ModsWorkspaceError(
      "workspace_not_found",
      `workspace_not_found: ${modsSrcRel(opts.modId)}`,
    );
  }
  const manifest = await readPlayonModManifest(opts.files, opts.modId);
  const dialect = dialectLiveDest(opts.dialect, opts.modId).ok
    ? opts.dialect
    : manifest.dialect;
  const dest = dialectLiveDest(dialect, opts.modId);
  if (!dest.ok) {
    throw new ModsWorkspaceError(dest.error, `${dest.error}: ${dest.dialect}`);
  }

  return opts.snapshotFirst(async () =>
    mutateDeployMod({
      files: opts.files,
      modId: opts.modId,
      dialect,
    }),
  );
}
