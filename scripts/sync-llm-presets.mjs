#!/usr/bin/env node
/**
 * Export LLM_PRESETS into sibling playon-games for public docs.
 *   node scripts/sync-llm-presets.mjs
 * Requires packages/shared built (dist/).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const siteGen = path.resolve(root, "..", "playon-games", "src", "generated");
const outFile = path.join(siteGen, "llm-presets.json");
const sharedDist = path.join(root, "packages", "shared", "dist", "index.js");

if (!fs.existsSync(sharedDist)) {
  console.error("packages/shared/dist missing — run pnpm --filter @playon/shared build first");
  process.exit(1);
}

if (!fs.existsSync(path.dirname(siteGen))) {
  console.error(`playon-games not found at ${path.resolve(root, "..", "playon-games")}`);
  process.exit(1);
}

const shared = await import(pathToFileURL(sharedDist).href);
const presets = shared.LLM_PRESET_LIST.map((p) => ({
  id: p.id,
  label: p.label,
  transport: p.transport,
  baseUrl: p.baseUrl,
  defaultModel: p.defaultModel,
  suggestedModels: p.suggestedModels,
  requiresApiKey: p.requiresApiKey,
  apiKeyLabel: p.apiKeyLabel,
  baseUrlEditable: p.baseUrlEditable,
  docsHint: p.docsHint ?? null,
  docsPath: p.docsPath ?? `/docs/providers/${p.id}`,
}));

const payload = {
  updatedAt: new Date().toISOString(),
  presets,
};

fs.mkdirSync(siteGen, { recursive: true });
fs.writeFileSync(outFile, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
console.log(`Wrote ${presets.length} presets → ${outFile}`);
