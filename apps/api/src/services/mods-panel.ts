/**
 * Host Mods panel payload: authored mods-src rows + the same error extract
 * `mods_errors` uses. Read-only. Never deploys or restarts.
 */
import { ServerFileStoreError, type ServerFileStore } from "./server-file-store.js";
import {
  dialectLogRelPaths,
  extractModErrors,
  type ModError,
  type ModErrorDialect,
} from "./mods-errors.js";
import { listAuthoredMods, type AuthoredModRow } from "./mods-workspace.js";

const FILE_TAIL_CHARS = 64_000;

async function tryReadLogFile(files: ServerFileStore, relPath: string): Promise<string | null> {
  try {
    const result = await files.readText(relPath, { maxBytes: FILE_TAIL_CHARS });
    return result.content;
  } catch (err) {
    if (err instanceof ServerFileStoreError && (err.code === "not_found" || err.code === "is_directory")) {
      return null;
    }
    return null;
  }
}

export type ServerModsPanel = {
  mods: AuthoredModRow[];
  errors: ModError[];
  dialect: ModErrorDialect;
  logSource: string;
};

export async function buildServerModsPanel(opts: {
  files: ServerFileStore;
  dialect: ModErrorDialect;
  runtimeLog?: string;
}): Promise<ServerModsPanel> {
  const mods = await listAuthoredMods(opts.files);
  const chunks: string[] = [];
  const logSources: string[] = [];
  if (opts.runtimeLog && opts.runtimeLog.trim()) {
    chunks.push(opts.runtimeLog);
    logSources.push("runtime");
  }
  for (const rel of dialectLogRelPaths(opts.dialect)) {
    const content = await tryReadLogFile(opts.files, rel);
    if (content && content.trim()) {
      chunks.push(content);
      logSources.push(rel);
    }
  }
  const errors = extractModErrors(opts.dialect, chunks.join("\n"));
  return {
    mods,
    errors,
    dialect: opts.dialect,
    logSource: logSources.join("+") || "none",
  };
}
