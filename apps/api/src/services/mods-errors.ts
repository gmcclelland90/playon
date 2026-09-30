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
    default:
      // v1: no pattern sets yet for other dialects (#994).
      return [];
  }
}
