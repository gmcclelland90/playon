import fs from "node:fs";
import path from "node:path";
import type { SkillMetadata, SkillNative } from "@playon/shared";

export interface NativeLaunch {
  command: string;
  args: string[];
  env: Record<string, string>;
  kind: "native" | "script";
}

function resolveScriptLaunch(gameDir: string): NativeLaunch | null {
  if (process.platform === "win32") {
    for (const name of ["start.bat", "run.bat"]) {
      const full = path.join(gameDir, name);
      if (fs.existsSync(full)) {
        return {
          kind: "script",
          command: "cmd.exe",
          args: ["/c", full],
          env: { PLAYON_GAME: "native" },
        };
      }
    }
    return null;
  }

  for (const name of ["start.sh", "runds.sh", "run.sh"]) {
    const full = path.join(gameDir, name);
    if (fs.existsSync(full)) {
      return {
        kind: "script",
        command: "/bin/bash",
        args: [full],
        env: { PLAYON_GAME: "native" },
      };
    }
  }
  return null;
}

function resolveBinaryLaunch(gameDir: string, native: SkillNative): NativeLaunch | null {
  const isWin = process.platform === "win32";
  const rel = (isWin && native.binaryWindows ? native.binaryWindows : native.binary)?.replace(
    /\\/g,
    "/",
  );
  if (!rel) return null;
  const binary = path.join(gameDir, ...rel.split("/"));
  if (!fs.existsSync(binary)) return null;

  const env: Record<string, string> = { PLAYON_GAME: "native", ...native.env };
  if (!isWin && native.libraryPathRelative.length > 0) {
    const parts = [
      ...native.libraryPathRelative.map((p) => path.join(gameDir, ...p.split("/"))),
      process.env.LD_LIBRARY_PATH,
    ].filter(Boolean) as string[];
    env.LD_LIBRARY_PATH = parts.join(":");
  }

  // Expand {{gameDir}} in args for logfile paths etc.
  const args = native.args.map((a) => a.replaceAll("{{gameDir}}", gameDir));

  return {
    kind: "native",
    command: binary,
    args,
    env,
  };
}

/** Pick a host process launch for a native skill's game/ directory. */
export function resolveNativeLaunch(opts: {
  skillName: string;
  game?: string | null;
  gameDir: string;
  /** Skill metadata when available — preferred over name heuristics. */
  metadata?: SkillMetadata | null;
}): NativeLaunch | null {
  const { gameDir, metadata } = opts;
  if (!fs.existsSync(gameDir)) return null;

  const native = metadata?.native;
  const preferScript = native?.preferStartScript !== false;
  if (preferScript) {
    const script = resolveScriptLaunch(gameDir);
    if (script) return script;
  }
  if (native) {
    const bin = resolveBinaryLaunch(gameDir, native);
    if (bin) return bin;
  }
  if (!preferScript) {
    const script = resolveScriptLaunch(gameDir);
    if (script) return script;
  }
  return null;
}

export function nativeGamePort(metadata?: SkillMetadata | null): number | null {
  const game = metadata?.ports.find((p) => p.name === "game" && p.default);
  return game?.default ?? null;
}

export function nativeRconPort(metadata?: SkillMetadata | null): number | null {
  const rcon = metadata?.ports.find((p) => p.name === "rcon" && p.default);
  return rcon?.default ?? null;
}
