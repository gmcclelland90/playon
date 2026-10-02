/**
 * Optional live smoke for fal mod assets (#988). Uses the key saved in
 * Settings → Mod assets (apps/api/data by default), or FAL_KEY if set.
 * Touches no game server: files go to a temp dir. Does not print the key.
 * Each run spends a few cents of the host's fal credit.
 *
 *   pnpm smoke:fal                 # icon (PZ size) + 2s sound
 *   pnpm smoke:fal icon texture    # pick kinds
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createDb } from "./db/client.js";
import { loadConfig } from "./config.js";
import {
  FAL_ASSET_KINDS,
  extensionForContentType,
  generateFalAsset,
  normalizeFalAssetKind,
  resolveFalApiKey,
  type FalAssetKind,
} from "./services/fal-assets.js";
import { FAL_SETTINGS_KEY, getSetting, type FalSettings } from "./services/settings.js";

const PROMPTS: Record<FalAssetKind, string> = {
  image: "a rusty crowbar on a workbench",
  sprite: "a rusty crowbar",
  icon: "a rusty crowbar",
  texture: "cracked concrete floor",
  sound: "short zombie groan",
};

async function loadKey(): Promise<string | null> {
  const fromEnv = process.env.FAL_KEY?.trim();
  if (fromEnv) return fromEnv;
  const dataRoot = process.env.PLAYON_DATA_ROOT ?? path.resolve(process.cwd(), "data");
  if (!fs.existsSync(path.join(dataRoot, "playon.db"))) return null;
  process.env.PLAYON_DATA_ROOT = dataRoot;
  const config = loadConfig(process.env);
  const { db } = createDb(config.dbPath);
  const stored = await getSetting<FalSettings>(db, FAL_SETTINGS_KEY);
  return resolveFalApiKey(stored, config.sessionSecret);
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  let kinds: FalAssetKind[];
  try {
    kinds = args.length ? args.map(normalizeFalAssetKind) : ["icon", "sound"];
  } catch {
    console.error(`kinds must be from: ${FAL_ASSET_KINDS.join(", ")}`);
    return 1;
  }
  const apiKey = await loadKey();
  if (!apiKey) {
    console.error("No fal key: save one in Settings → Mod assets or set FAL_KEY.");
    return 1;
  }
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "playon-fal-smoke-"));
  let failed = 0;
  for (const kind of kinds) {
    const started = Date.now();
    try {
      const out = await generateFalAsset({
        apiKey,
        kind,
        prompt: PROMPTS[kind],
        dialect: "project-zomboid",
        seconds: 2,
      });
      const file = path.join(outDir, `${kind}.${extensionForContentType(out.contentType)}`);
      fs.writeFileSync(file, out.bytes);
      const dims = out.width ? ` ${out.width}x${out.height}` : "";
      const secs = ((Date.now() - started) / 1000).toFixed(1);
      console.log(`ok ${kind} ${out.contentType}${dims} ${out.bytes.byteLength}B ${secs}s → ${file}`);
    } catch (err) {
      failed++;
      const code = (err as { code?: string }).code ?? "error";
      console.error(`fail ${kind} ${code}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  console.log(failed ? `fal_smoke=failed (${failed}/${kinds.length})` : "fal_smoke=ok");
  return failed ? 1 : 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  },
);
