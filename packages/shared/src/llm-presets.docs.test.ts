import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { LLM_PRESET_IDS, LLM_PRESET_LIST } from "./llm-presets.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const monorepoRoot = path.resolve(here, "../../..");
const siteRoot = path.resolve(monorepoRoot, "..", "playon-games");
const generatedPath = path.join(siteRoot, "src", "generated", "llm-presets.json");
const docsRoot = path.join(siteRoot, "src", "content", "docs");

function docsFileForPath(docsPath: string): string {
  const slug = docsPath.replace(/^\/docs\//, "");
  return path.join(docsRoot, `${slug}.md`);
}

describe("llm preset public docs freshness", () => {
  it("every preset declares a docsPath under /docs/providers/", () => {
    for (const preset of LLM_PRESET_LIST) {
      expect(preset.docsPath, preset.id).toBe(`/docs/providers/${preset.id}`);
    }
  });

  it("sibling playon-games generated JSON and guide pages stay in sync", () => {
    // Full marketing checkout only. A stub sibling (e.g. skills-src only on the lab)
    // must not force sync:llm-presets — CI without playon-games still validates docsPath above.
    if (!fs.existsSync(siteRoot) || !fs.existsSync(docsRoot)) {
      return;
    }

    expect(fs.existsSync(generatedPath), `missing ${generatedPath} — run pnpm sync:llm-presets`).toBe(
      true,
    );

    const payload = JSON.parse(fs.readFileSync(generatedPath, "utf8")) as {
      presets: Array<{
        id: string;
        label: string;
        baseUrl: string;
        defaultModel: string;
        suggestedModels: string[];
        requiresApiKey: boolean;
        docsPath: string;
      }>;
    };

    expect(payload.presets.map((p) => p.id)).toEqual([...LLM_PRESET_IDS]);

    for (const preset of LLM_PRESET_LIST) {
      const row = payload.presets.find((p) => p.id === preset.id);
      expect(row, preset.id).toBeTruthy();
      expect(row!.label).toBe(preset.label);
      expect(row!.baseUrl).toBe(preset.baseUrl);
      expect(row!.defaultModel).toBe(preset.defaultModel);
      expect(row!.suggestedModels).toEqual(preset.suggestedModels);
      expect(row!.requiresApiKey).toBe(preset.requiresApiKey);
      expect(row!.docsPath).toBe(preset.docsPath);

      const guide = docsFileForPath(preset.docsPath!);
      expect(fs.existsSync(guide), `missing guide ${guide}`).toBe(true);
      const body = fs.readFileSync(guide, "utf8");
      expect(body).toMatch(new RegExp(`presetId:\\s*${preset.id}`));
    }

    for (const required of [
      "quick-start.md",
      "players.md",
      "skills.md",
      "providers.md",
      "mcp.md",
      "mcp/cursor.md",
      "mcp/claude-code.md",
      "mcp/codex.md",
      "mcp/openclaw.md",
      "mcp/hermes.md",
      "mcp/generic.md",
    ]) {
      expect(fs.existsSync(path.join(docsRoot, required)), required).toBe(true);
    }
  });
});
