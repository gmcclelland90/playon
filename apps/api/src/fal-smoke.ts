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
import {
  FAL_ASSET_KINDS,
  extensionForContentType,
  generateFalAsset,
  normalizeFalAssetKind,
  resolveFalApiKey,
  type FalAssetKind,
} from "./services/fal-assets.js";
import { decodePng, isPng } from "./services/png-lite.js";

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
  // Lazy so CI (FAL_KEY set) runs without building workspace packages.
  const { loadConfig } = await import("./config.js");
  const { createDb } = await import("./db/client.js");
  const { FAL_SETTINGS_KEY, getSetting } = await import("./services/settings.js");
  const config = loadConfig(process.env);
  const { db } = createDb(config.dbPath);
  const stored = await getSetting<{ apiKeyEncrypted?: string }>(db, FAL_SETTINGS_KEY);
  return resolveFalApiKey(stored, config.sessionSecret);
}

/** Throw unless the bytes are what a game could actually load for this kind. */
function checkOutput(kind: FalAssetKind, contentType: string, bytes: Uint8Array): void {
  if (bytes.byteLength < 64) throw new Error(`too_small ${bytes.byteLength}B`);
  if (kind === "sound") {
    const magic = String.fromCharCode(...bytes.subarray(0, 4));
    if (!["RIFF", "OggS", "fLaC"].includes(magic) && !magic.startsWith("ID3") && bytes[0] !== 0xff) {
      throw new Error(`not_audio ${contentType}`);
    }
    return;
  }
  if (!isPng(bytes)) {
    if (kind === "image") return; // raw image may be any format fal returns
    throw new Error(`not_png ${contentType}`);
  }
  const img = decodePng(bytes);
  if (kind === "icon" && (img.width !== 32 || img.height !== 32)) {
    throw new Error(`icon_size ${img.width}x${img.height} (want 32x32 for PZ)`);
  }
  if (kind === "texture" && (img.width !== 256 || img.height !== 256)) {
    throw new Error(`texture_size ${img.width}x${img.height} (want 256x256)`);
  }
  if (kind === "icon" || kind === "sprite") {
    let transparent = 0;
    for (let i = 3; i < img.data.length; i += 4) if (img.data[i]! < 250) transparent++;
    if (transparent === 0) throw new Error("no_transparency (background removal did nothing)");
  }
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
  const outDir = process.env.FAL_SMOKE_OUT
    ? path.resolve(process.env.FAL_SMOKE_OUT)
    : fs.mkdtempSync(path.join(os.tmpdir(), "playon-fal-smoke-"));
  fs.mkdirSync(outDir, { recursive: true });
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
      checkOutput(kind, out.contentType, out.bytes);
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
