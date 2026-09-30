/**
 * Project Zomboid Steam Workshop packaging (dry-run).
 * Stages a jail-local zip under workshop-out/; never uploads to Steam.
 * Live publish requires host Steam credentials → blocked_human.
 */
import { zipSync } from "fflate";
import { PLAYON_DEPLOY_JSON, PLAYON_MOD_JSON } from "@playon/shared";
import {
  ModsWorkspaceError,
  assertSafeModId,
  jailRel,
  modsSrcRel,
  readPlayonModManifest,
} from "./mods-workspace.js";
import { ServerFileStoreError, type ServerFileStore } from "./server-file-store.js";

export const WORKSHOP_OUT_DIR = "workshop-out";

export type ModsWorkshopErrorCode =
  | ModsWorkspaceError["code"]
  | "unsupported_dialect"
  | "empty_workspace"
  | "steam_credentials_human_gate";

export class ModsWorkshopError extends Error {
  readonly code: ModsWorkshopErrorCode;

  constructor(code: ModsWorkshopErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = "ModsWorkshopError";
    this.code = code;
  }
}

export type WorkshopPreview = {
  modId: string;
  dialect: string;
  displayName: string;
  version: string;
  title: string;
  description: string;
  entryCount: number;
  entries: string[];
  zipPath: string;
  previewPath: string;
  livePublish: false;
  note: string;
};

export type WorkshopPrepareResult =
  | {
      ok: true;
      dryRun: true;
      preview: WorkshopPreview;
      bytes: number;
    }
  | {
      ok: false;
      dryRun: true;
      preview: WorkshopPreview;
      bytes: number;
      blockedHuman: {
        error: "blocked_human";
        code: "steam_credentials_human_gate";
        hint: string;
      };
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

function shouldSkipPackEntry(relFromSrc: string): boolean {
  const base = relFromSrc.split("/").pop() ?? relFromSrc;
  return base === PLAYON_MOD_JSON || base === PLAYON_DEPLOY_JSON;
}

const LIVE_PUBLISH_HINT =
  "Steam Workshop live publish needs a Steam account + Workshop credentials on this host. Dry-run zip is staged under workshop-out/; upload remains blocked-human (no SteamCMD publish from PlayOn yet).";

/**
 * Package `mods-src/<modId>/` (minus PlayOn manifests) into
 * `workshop-out/<modId>/<modId>-workshop.zip` with Workshop-style
 * `mods/<modId>/…` layout. Never contacts Steam.
 *
 * When `livePublish` is true, still stages the dry-run zip but returns
 * `blocked_human` / `steam_credentials_human_gate` — no upload path exists.
 */
export async function preparePzWorkshopDryRun(opts: {
  files: ServerFileStore;
  modId: string;
  livePublish?: boolean;
  title?: string;
  description?: string;
}): Promise<WorkshopPrepareResult> {
  const modId = assertSafeModId(opts.modId);
  const src = modsSrcRel(modId);
  const listing = await dirEntries(opts.files, src);
  if (!listing) {
    throw new ModsWorkshopError("workspace_not_found", `workspace_not_found: ${src}`);
  }

  let manifest;
  try {
    manifest = await readPlayonModManifest(opts.files, modId);
  } catch (err) {
    if (err instanceof ModsWorkspaceError) {
      throw new ModsWorkshopError(err.code, err.message, { cause: err });
    }
    throw err;
  }

  if (manifest.dialect !== "project-zomboid") {
    throw new ModsWorkshopError(
      "unsupported_dialect",
      `unsupported_dialect: Workshop dry-run is PZ-only (got ${manifest.dialect})`,
    );
  }

  const all = await walkFiles(opts.files, src);
  const zipFiles: Record<string, Uint8Array> = {};
  const entries: string[] = [];

  for (const abs of all) {
    const relFromSrc = abs.slice(src.length).replace(/^\/+/, "");
    if (!relFromSrc || shouldSkipPackEntry(relFromSrc)) continue;
    const zipEntry = `mods/${modId}/${relFromSrc}`;
    const { data } = await opts.files.readBytes(abs);
    zipFiles[zipEntry] = new Uint8Array(data);
    entries.push(zipEntry);
  }

  if (entries.length === 0) {
    throw new ModsWorkshopError("empty_workspace", `empty_workspace: ${src}`);
  }

  entries.sort();
  const title = (opts.title?.trim() || manifest.displayName || modId).slice(0, 128);
  const description = (
    opts.description?.trim() ||
    `PlayOn AI-authored Project Zomboid mod "${manifest.displayName}" (${modId}).`
  ).slice(0, 2000);

  const outDir = jailRel(WORKSHOP_OUT_DIR, modId);
  const zipPath = jailRel(outDir, `${modId}-workshop.zip`);
  const previewPath = jailRel(outDir, "workshop-preview.json");

  const zipBytes = zipSync(zipFiles, { level: 6 });
  await opts.files.ensureDir(outDir);
  await opts.files.writeBytes(zipPath, Buffer.from(zipBytes));

  const preview: WorkshopPreview = {
    modId,
    dialect: manifest.dialect,
    displayName: manifest.displayName,
    version: manifest.version,
    title,
    description,
    entryCount: entries.length,
    entries,
    zipPath,
    previewPath,
    livePublish: false,
    note: "Dry-run only. Zip staged in the server jail; Steam upload is not performed.",
  };
  await opts.files.writeText(previewPath, `${JSON.stringify(preview, null, 2)}\n`);

  if (opts.livePublish) {
    return {
      ok: false,
      dryRun: true,
      preview,
      bytes: zipBytes.byteLength,
      blockedHuman: {
        error: "blocked_human",
        code: "steam_credentials_human_gate",
        hint: LIVE_PUBLISH_HINT,
      },
    };
  }

  return {
    ok: true,
    dryRun: true,
    preview,
    bytes: zipBytes.byteLength,
  };
}
