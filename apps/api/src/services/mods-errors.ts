/**
 * Dialect-aware extraction of mod/plugin load errors from server log text.
 * Used by the read-only `mods_errors` tool (#990). Parsers invent nothing —
 * every returned mod name/file/line must appear in the source text.
 */

export type ModErrorDialect =
  | "project-zomboid"
  | "minecraft-paper"
  | "rust-oxide"
  | "garrys-mod"
  | "terraria-tmod"
  | "factorio"
  | "none"
  | "unknown";

export type ModErrorKind =
  | "lua_stack"
  | "lua_nil"
  | "exception"
  | "plugin_enable"
  | "plugin_load"
  | "compile"
  | "dependency"
  | "other";

export type ModError = {
  kind: ModErrorKind;
  mod?: string;
  file?: string;
  line?: number;
  message: string;
  excerpt: string;
};

/** Map a PlayOn skill name (e.g. games.project-zomboid) to a mod dialect. */
export function resolveModDialect(skillName: string | null | undefined): ModErrorDialect {
  const raw = (skillName ?? "").trim().toLowerCase();
  if (!raw) return "unknown";
  const slug = raw.includes(".") ? raw.slice(raw.indexOf(".") + 1) : raw;
  if (slug === "project-zomboid" || slug === "project_zomboid" || slug.includes("zomboid")) {
    return "project-zomboid";
  }
  if (
    slug === "minecraft-paper" ||
    slug === "minecraft_paper" ||
    slug === "paper" ||
    (slug.includes("minecraft") && slug.includes("paper"))
  ) {
    return "minecraft-paper";
  }
  if (slug.includes("rust") || slug.includes("oxide") || slug.includes("carbon")) {
    return "rust-oxide";
  }
  if (slug.includes("garrys") || slug === "gmod" || slug.includes("garry")) {
    return "garrys-mod";
  }
  if (slug.includes("tmod") || slug.includes("terraria")) {
    return "terraria-tmod";
  }
  if (slug.includes("factorio")) {
    return "factorio";
  }
  return "unknown";
}

/** Well-known relative log paths to also sample when present (jail-relative). */
export function dialectLogRelPaths(dialect: ModErrorDialect): string[] {
  switch (dialect) {
    case "project-zomboid":
      return ["console.txt", "server-console.txt"];
    case "minecraft-paper":
      return ["logs/latest.log", "logs/latest.log.gz"];
    case "rust-oxide":
      return ["oxide/logs/oxide_log.txt", "carbon/logs/Carbon.log", "logs/oxide_log.txt"];
    case "garrys-mod":
      return ["garrysmod/console.log", "garrysmod/logs/console.log"];
    case "terraria-tmod":
      return ["tModLoader-Logs/server.log", "Logs/server.log", "server.log"];
    case "factorio":
      return ["factorio-current.log", "factorio-previous.log"];
    default:
      return [];
  }
}

const LUA_MOD_RE =
  /Lua\(\(MOD:(?<mod>[^)]+)\)\)\.(?<fn>[A-Za-z0-9_]+)\((?<file>[^:)]+):(?<line>\d+)\)/g;
const NIL_CALL_RE = /Object tried to call nil(?:\s+in\s+(?<fn>[A-Za-z0-9_]+))?/i;
const PAPER_ENABLE_RE =
  /(?:Error|Exception)\s+occurred\s+while\s+enabling\s+(?<mod>\S+)/i;
const PAPER_LOAD_RE =
  /Could not load\s+['\"]?(?<mod>[^'\"]+)['\"]?\s+plugin/i;
const PAPER_PLUGIN_EX_RE =
  /Error\s+enabling\s+plugin\s+(?<mod>\S+)/i;

function pushUnique(out: ModError[], next: ModError): void {
  const key = `${next.kind}|${next.mod ?? ""}|${next.file ?? ""}|${next.line ?? ""}|${next.message}`;
  if (out.some((e) => `${e.kind}|${e.mod ?? ""}|${e.file ?? ""}|${e.line ?? ""}|${e.message}` === key)) {
    return;
  }
  out.push(next);
}

function excerptAround(lines: string[], index: number, radius = 2): string {
  const start = Math.max(0, index - radius);
  const end = Math.min(lines.length, index + radius + 1);
  return lines.slice(start, end).join("\n");
}

function extractPz(text: string): ModError[] {
  const lines = text.split(/\r?\n/);
  const out: ModError[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    LUA_MOD_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = LUA_MOD_RE.exec(line)) !== null) {
      const mod = m.groups?.mod?.trim();
      const file = m.groups?.file?.trim();
      const lineNo = m.groups?.line ? Number(m.groups.line) : undefined;
      const fn = m.groups?.fn?.trim();
      // Look ahead a few lines for nil-call companion
      let nilMsg: string | undefined;
      for (let j = i; j < Math.min(lines.length, i + 4); j++) {
        const nm = lines[j]!.match(NIL_CALL_RE);
        if (nm) {
          nilMsg = lines[j]!.trim();
          break;
        }
      }
      const message = nilMsg
        ? `${m[0]}; ${nilMsg}`
        : fn
          ? `${m[0]}`
          : m[0];
      pushUnique(out, {
        kind: nilMsg ? "lua_nil" : "lua_stack",
        mod,
        file,
        line: Number.isFinite(lineNo) ? lineNo : undefined,
        message,
        excerpt: excerptAround(lines, i),
      });
    }

    if (/\bSTACK TRACE\b/i.test(line) || /\bException thrown\b/i.test(line)) {
      // Prefer pairing with a nearby Lua((MOD:…)) line; otherwise record the marker.
      let paired = false;
      for (let j = Math.max(0, i - 2); j < Math.min(lines.length, i + 6); j++) {
        LUA_MOD_RE.lastIndex = 0;
        if (LUA_MOD_RE.test(lines[j]!)) {
          paired = true;
          break;
        }
      }
      if (!paired) {
        pushUnique(out, {
          kind: /\bException thrown\b/i.test(line) ? "exception" : "lua_stack",
          message: line.trim(),
          excerpt: excerptAround(lines, i),
        });
      }
    }

    const nilOnly = line.match(NIL_CALL_RE);
    if (nilOnly && !line.includes("Lua((MOD:")) {
      // Standalone nil line — only keep if not already attached above.
      const already = out.some(
        (e) => e.kind === "lua_nil" && e.excerpt.includes(line.trim()),
      );
      if (!already) {
        pushUnique(out, {
          kind: "lua_nil",
          message: line.trim(),
          excerpt: excerptAround(lines, i),
        });
      }
    }
  }

  return out;
}

function extractPaper(text: string): ModError[] {
  const lines = text.split(/\r?\n/);
  const out: ModError[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const enable =
      line.match(PAPER_ENABLE_RE) ||
      line.match(PAPER_PLUGIN_EX_RE);
    if (enable?.groups?.mod) {
      pushUnique(out, {
        kind: "plugin_enable",
        mod: enable.groups.mod.replace(/[,.]$/, ""),
        message: line.trim(),
        excerpt: excerptAround(lines, i, 3),
      });
      continue;
    }
    const load = line.match(PAPER_LOAD_RE);
    if (load?.groups?.mod) {
      pushUnique(out, {
        kind: "plugin_load",
        mod: load.groups.mod.trim(),
        message: line.trim(),
        excerpt: excerptAround(lines, i, 3),
      });
      continue;
    }
    // Generic plugin exception blocks
    if (/org\.bukkit\.plugin\.InvalidPluginException/i.test(line) ||
        /Error loading plugin/i.test(line)) {
      pushUnique(out, {
        kind: "plugin_load",
        message: line.trim(),
        excerpt: excerptAround(lines, i, 3),
      });
    }
  }

  return out;
}


const OXIDE_FAIL_RE =
  /Failed to (?:compile|initialize) (?:plugin )?(?<mod>\S+)/i;
const OXIDE_CS_RE =
  /(?:error CS\d+|Compilation failed).*?(?<mod>\S+\.cs)/i;
const GMOD_LUA_RE =
  /\[ERROR\](?<file>[^:]+):(?<line>\d+):\s*(?<message>.+)/i;
const GMOD_ADDON_RE =
  /Addon ['\"](?<mod>[^'\"]+)['\"] (?:failed|error)/i;
const TMOD_LOAD_RE =
  /An error occurred while loading(?: mod)?\s*(?<mod>\S+)?/i;
const TMOD_EX_RE =
  /tModLoader(?:\.|\s)+(?:Error|Exception).*/i;
const FACTORIO_FAIL_RE =
  /Failed to load mod(?:\s+['\"]?(?<mod>[^'\"]+)['\"]?)?/i;
const FACTORIO_ERR_RE =
  /Error while loading(?: mod)?\s*(?<mod>\S+)?/i;
const FACTORIO_DEP_RE =
  /Mods to be disabled:(?<rest>.*)/i;

function extractOxide(text: string): ModError[] {
  const lines = text.split(/\r?\n/);
  const out: ModError[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const fail = line.match(OXIDE_FAIL_RE);
    if (fail?.groups?.mod) {
      pushUnique(out, {
        kind: /compile/i.test(line) ? "compile" : "plugin_load",
        mod: fail.groups.mod.replace(/[,.:]$/, ""),
        message: line.trim(),
        excerpt: excerptAround(lines, i, 3),
      });
      continue;
    }
    const cs = line.match(OXIDE_CS_RE);
    if (cs?.groups?.mod) {
      pushUnique(out, {
        kind: "compile",
        mod: cs.groups.mod,
        file: cs.groups.mod,
        message: line.trim(),
        excerpt: excerptAround(lines, i, 2),
      });
    }
  }
  return out;
}

function extractGmod(text: string): ModError[] {
  const lines = text.split(/\r?\n/);
  const out: ModError[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const err = line.match(GMOD_LUA_RE);
    if (err?.groups) {
      const file = err.groups.file?.trim();
      const lineNo = err.groups.line ? Number(err.groups.line) : undefined;
      pushUnique(out, {
        kind: "lua_stack",
        file,
        line: Number.isFinite(lineNo) ? lineNo : undefined,
        message: (err.groups.message ?? line).trim(),
        excerpt: excerptAround(lines, i, 2),
      });
      continue;
    }
    const addon = line.match(GMOD_ADDON_RE);
    if (addon?.groups?.mod) {
      pushUnique(out, {
        kind: "plugin_load",
        mod: addon.groups.mod,
        message: line.trim(),
        excerpt: excerptAround(lines, i, 2),
      });
    }
  }
  return out;
}

function extractTmod(text: string): ModError[] {
  const lines = text.split(/\r?\n/);
  const out: ModError[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const load = line.match(TMOD_LOAD_RE);
    if (load) {
      pushUnique(out, {
        kind: "plugin_load",
        mod: load.groups?.mod?.replace(/[,.:]$/, ""),
        message: line.trim(),
        excerpt: excerptAround(lines, i, 3),
      });
      continue;
    }
    if (TMOD_EX_RE.test(line)) {
      pushUnique(out, {
        kind: "exception",
        message: line.trim(),
        excerpt: excerptAround(lines, i, 3),
      });
    }
  }
  return out;
}

function extractFactorio(text: string): ModError[] {
  const lines = text.split(/\r?\n/);
  const out: ModError[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const fail = line.match(FACTORIO_FAIL_RE) || line.match(FACTORIO_ERR_RE);
    if (fail) {
      pushUnique(out, {
        kind: "plugin_load",
        mod: fail.groups?.mod?.replace(/[,.:]$/, ""),
        message: line.trim(),
        excerpt: excerptAround(lines, i, 3),
      });
      continue;
    }
    const dep = line.match(FACTORIO_DEP_RE);
    if (dep) {
      pushUnique(out, {
        kind: "dependency",
        message: line.trim(),
        excerpt: excerptAround(lines, i, 2),
      });
    }
  }
  return out;
}

/** Extract mod/plugin errors for a dialect from concatenated log text. */
export function extractModErrors(
  dialect: ModErrorDialect,
  text: string,
): ModError[] {
  if (!text.trim()) return [];
  switch (dialect) {
    case "project-zomboid":
      return extractPz(text);
    case "minecraft-paper":
      return extractPaper(text);
    case "rust-oxide":
      return extractOxide(text);
    case "garrys-mod":
      return extractGmod(text);
    case "terraria-tmod":
      return extractTmod(text);
    case "factorio":
      return extractFactorio(text);
    default:
      return [];
  }
}
