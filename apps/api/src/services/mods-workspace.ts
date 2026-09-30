/**
 * Jailed mods-src workspace helpers for AI-authored mods (#991).
 * Pure path/content helpers stay unit-testable without a live plane.
 */

import type { ModErrorDialect } from "./mods-errors.js";
import { resolveModDialect } from "./mods-errors.js";

const MOD_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export type PlayOnModMeta = {
  dialect: ModErrorDialect;
  displayName: string;
  clientNeed: "none" | "auto" | "manual";
  version: string;
  modId: string;
};

export function assertModId(modId: string): string {
  const id = modId.trim();
  if (!MOD_ID_RE.test(id)) {
    throw new Error(
      `invalid_mod_id: ${modId} (use 1–64 letters/digits/_/- starting with alphanumeric)`,
    );
  }
  return id;
}

export function modsSrcRel(modId: string): string {
  return `mods-src/${assertModId(modId)}`;
}

export function playonModJsonRel(modId: string): string {
  return `${modsSrcRel(modId)}/playon-mod.json`;
}

/** Live deploy destination (relative to jail) for a dialect. */
export function dialectDeployDest(
  dialect: ModErrorDialect,
  modId: string,
): { destDir: string; enable: "mods_ini" | "presence" | "mod_list_json" | "unsupported" } {
  const id = assertModId(modId);
  switch (dialect) {
    case "project-zomboid":
      return { destDir: `mods/${id}`, enable: "mods_ini" };
    case "minecraft-paper":
      return { destDir: `plugins/${id}`, enable: "presence" };
    case "rust-oxide":
      return { destDir: `oxide/plugins`, enable: "presence" };
    case "garrys-mod":
      return { destDir: `garrysmod/addons/${id}`, enable: "presence" };
    case "terraria-tmod":
      return { destDir: `Mods/${id}`, enable: "presence" };
    case "factorio":
      return { destDir: `mods/${id}`, enable: "mod_list_json" };
    default:
      return { destDir: "", enable: "unsupported" };
  }
}

export function defaultClientNeed(dialect: ModErrorDialect): PlayOnModMeta["clientNeed"] {
  switch (dialect) {
    case "project-zomboid":
    case "garrys-mod":
    case "terraria-tmod":
    case "factorio":
      return "manual";
    case "minecraft-paper":
    case "rust-oxide":
      return "none";
    default:
      return "none";
  }
}

/** Files to write for a fresh scaffold (paths relative to mods-src/<modId>/). */
export function scaffoldFiles(
  dialect: ModErrorDialect,
  modId: string,
  displayName: string,
): Record<string, string> {
  const id = assertModId(modId);
  const name = displayName.trim() || id;
  const meta: PlayOnModMeta = {
    dialect,
    displayName: name,
    clientNeed: defaultClientNeed(dialect),
    version: "0.1.0",
    modId: id,
  };
  const files: Record<string, string> = {
    "playon-mod.json": `${JSON.stringify(meta, null, 2)}\n`,
  };

  switch (dialect) {
    case "project-zomboid":
      files["mod.info"] = [
        `name=${name}`,
        `id=${id}`,
        `description=Authored via PlayOn AI modding`,
        `poster=`,
        "",
      ].join("\n");
      files["media/lua/server/PlayOnAuthored.lua"] = [
        `-- ${name} (PlayOn AI scaffold)`,
        `local Mod = {}`,
        `function Mod.hello()`,
        `  print("[${id}] loaded")`,
        `end`,
        `return Mod`,
        "",
      ].join("\n");
      break;
    case "minecraft-paper":
      files["plugin.yml"] = [
        `name: ${id}`,
        `version: 0.1.0`,
        `main: playon.authored.${id}.Plugin`,
        `api-version: '1.20'`,
        `description: ${name}`,
        "",
      ].join("\n");
      files["README.md"] = `# ${name}\n\nPaper plugin scaffold. Drop a built jar into plugins/ on deploy, or keep sources here for the agent to iterate.\n`;
      break;
    case "rust-oxide":
      files[`${id}.cs`] = [
        `// ${name} — Oxide/Carbon plugin scaffold (PlayOn)`,
        `namespace Oxide.Plugins;`,
        `[Info("${name}", "PlayOn", "0.1.0")]`,
        `public class ${id} : RustPlugin`,
        `{`,
        `    void OnServerInitialized() => Puts("${id} loaded");`,
        `}`,
        "",
      ].join("\n");
      break;
    case "garrys-mod":
      files["addon.json"] = `${JSON.stringify({ title: name, type: "ServerContent", tags: ["roleplay"] }, null, 2)}\n`;
      files["lua/autorun/server/sv_playon_authored.lua"] = `print("[${id}] loaded")\n`;
      break;
    case "terraria-tmod":
      files["description.txt"] = `${name}\nAuthored via PlayOn\n`;
      files["build.txt"] = `displayName = ${name}\nauthor = PlayOn\nversion = 0.1.0\n`;
      break;
    case "factorio":
      files["info.json"] = `${JSON.stringify(
        {
          name: id,
          version: "0.1.0",
          title: name,
          author: "PlayOn",
          factorio_version: "2.0",
          description: name,
        },
        null,
        2,
      )}\n`;
      files["control.lua"] = `script.on_init(function() log("[${id}] loaded") end)\n`;
      break;
    default:
      files["README.md"] = `# ${name}\n\nUnsupported dialect scaffold — fill in sources manually.\n`;
  }

  return files;
}

/**
 * Patch a Project Zomboid server INI Mods= line to include modId (semicolon list).
 * Returns the new content and whether a change was made.
 */
export function patchPzModsIni(content: string, modId: string): { content: string; patched: boolean } {
  const id = assertModId(modId);
  const lines = content.split(/\r?\n/);
  let patched = false;
  const out = lines.map((line) => {
    const m = line.match(/^\s*Mods\s*=\s*(.*)$/i);
    if (!m) return line;
    const raw = (m[1] ?? "").trim();
    const parts = raw ? raw.split(/;/).map((s) => s.trim()).filter(Boolean) : [];
    if (parts.includes(id)) return line;
    parts.push(id);
    patched = true;
    return `Mods=${parts.join(";")}`;
  });
  if (!patched && !/^\s*Mods\s*=/im.test(content)) {
    out.push(`Mods=${id}`);
    patched = true;
  }
  return { content: out.join("\n"), patched };
}

/** Ensure Factorio mod-list.json enables modId. */
export function patchFactorioModList(
  content: string,
  modId: string,
): { content: string; patched: boolean } {
  const id = assertModId(modId);
  let data: { mods?: Array<{ name: string; enabled: boolean }> };
  try {
    data = JSON.parse(content || '{"mods":[]}');
  } catch {
    data = { mods: [] };
  }
  if (!Array.isArray(data.mods)) data.mods = [];
  const existing = data.mods.find((m) => m.name === id);
  if (existing) {
    if (existing.enabled) return { content: `${JSON.stringify(data, null, 2)}\n`, patched: false };
    existing.enabled = true;
    return { content: `${JSON.stringify(data, null, 2)}\n`, patched: true };
  }
  data.mods.push({ name: id, enabled: true });
  return { content: `${JSON.stringify(data, null, 2)}\n`, patched: true };
}

export function resolveDialectForServer(
  skillName: string | null | undefined,
  override?: string | null,
): ModErrorDialect {
  if (override && override.trim()) {
    const d = resolveModDialect(override.trim());
    if (d !== "unknown") return d;
  }
  return resolveModDialect(skillName);
}
