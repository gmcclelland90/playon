/**
 * Project Zomboid launch identity (#1016).
 *
 * Catalog `games.project-zomboid` start.sh (playon-games) and a managed
 * `.playon-start.env` copied from another install will pass
 * `-servername NewZombieLand3` and `-port 16261` unless Home replaces them.
 * Every start derives the server name, userdata home, and game/direct ports
 * from this server's own `Server/<world>.ini` and its own jail. A missing
 * value fails the start. Skill defaults (`servertest`, 16261, 16262) are not
 * a fallback.
 *
 * The #1046 isolation guard still runs on the identity this module commits.
 *
 * Other start builders that still pin one skill-default port, and are not
 * this NZL clone path: Bannerlord `/port 7210`, Foundry `server_port` 3724,
 * Stormworks UDP 25564, and Docker publish of skill `ports.default`.
 */
import { pathBelongsToServer } from "./start-identity.js";

export const PZ_SKILL_NAME = "games.project-zomboid";

export type PzWorldIni = {
  name: string;
  defaultPort: number | null;
  udpPort: number | null;
};

export type PzPeerName = {
  id: string;
  /** Display name. The row named for a world owns that world. */
  name: string;
};

export type PzLaunchIdentity = {
  serverName: string;
  gamePort: number;
  directPort: number;
  /**
   * Absolute userdata root when this process knows it. Omitted for a remote
   * jail whose start script already resolves `../home` inside its own tree.
   */
  playonHome?: string;
};

export type PzResolveResult =
  | { ok: true; identity: { serverName: string; gamePort: number; directPort: number } }
  | { ok: false; error: string };

const same = (a: string | undefined, b: string | undefined): boolean =>
  !!a && !!b && a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * A peer owns a world when its display name is that world. A copied
 * `PLAYON_SERVER_NAME` on some other row does not — otherwise the real NZL
 * would look like it was using the clone's identity.
 */
function peerOwnsWorld(peers: readonly PzPeerName[], world: string, selfId: string): boolean {
  return peers.some((peer) => peer.id !== selfId && same(peer.name, world));
}

/**
 * Pick this server's world and ports. Never returns another server's name or
 * the catalog defaults.
 */
export function resolvePzStartIdentity(input: {
  id: string;
  /** Display name, used only when it matches one of this server's own worlds. */
  name?: string;
  worlds: readonly PzWorldIni[];
  peers: readonly PzPeerName[];
}): PzResolveResult {
  const own = input.worlds.filter(
    (world) => world.name.trim() && !peerOwnsWorld(input.peers, world.name, input.id),
  );
  if (own.length === 0) {
    const found = input.worlds.map((world) => world.name).filter(Boolean);
    const suffix = found.length
      ? ` (found ${found.join(", ")}, which belongs to another server)`
      : "";
    return {
      ok: false,
      error:
        `start_config_missing: server ${input.id} has no Server/<world>.ini of its own${suffix}; ` +
        `refusing a default server name and port`,
    };
  }
  const named = own.find((world) => same(world.name, input.name));
  const world = named ?? (own.length === 1 ? own[0] : undefined);
  if (!world) {
    return {
      ok: false,
      error:
        `start_config_ambiguous: server ${input.id} has more than one world ` +
        `(${own.map((item) => item.name).join(", ")}); the server name has to match the world to launch`,
    };
  }
  if (world.defaultPort == null) {
    return {
      ok: false,
      error:
        `start_config_missing: Server/${world.name}.ini has no DefaultPort; ` +
        `refusing a default game port`,
    };
  }
  if (world.udpPort == null) {
    return {
      ok: false,
      error:
        `start_config_missing: Server/${world.name}.ini has no UDPPort; ` +
        `refusing a default direct port`,
    };
  }
  return {
    ok: true,
    identity: {
      serverName: world.name,
      gamePort: world.defaultPort,
      directPort: world.udpPort,
    },
  };
}

/**
 * Userdata home for this server. A local jail always uses its own
 * `servers/<id>/home`. A remote inherited path is kept only when it already
 * sits in this server's jail; a path that names another server is retargeted
 * to this id (same prefix, this server's directory). Anything else is refused.
 */
export function choosePzHome(input: {
  serverId: string;
  remote: boolean;
  localHome: string;
  inheritedHome?: string;
}): { home?: string; error?: string } {
  if (!input.remote) {
    if (!pathBelongsToServer(input.localHome, input.serverId)) {
      return {
        error: `start_config_home: ${input.localHome} is outside servers/${input.serverId}`,
      };
    }
    return { home: input.localHome };
  }
  const inherited = input.inheritedHome?.trim();
  if (!inherited) return {};
  if (pathBelongsToServer(inherited, input.serverId)) return { home: inherited };
  const retargeted = retargetServerPath(inherited, input.serverId);
  if (retargeted && pathBelongsToServer(retargeted, input.serverId)) {
    return { home: retargeted };
  }
  return {
    error: `start_config_home: PLAYON_HOME ${inherited} is outside servers/${input.serverId}`,
  };
}

/** Swap the `servers/<id>` segment so a copied absolute home points at this server. */
export function retargetServerPath(absPath: string, serverId: string): string | null {
  const slash = absPath.includes("\\") && !absPath.includes("/") ? "\\" : "/";
  const parts = absPath.split(/[\\/]+/);
  const serversIdx = parts.lastIndexOf("servers");
  if (serversIdx < 0 || serversIdx + 1 >= parts.length) return null;
  parts[serversIdx + 1] = serverId;
  if (absPath.startsWith("/") && parts[0] === "") return parts.join("/");
  if (/^[A-Za-z]:/.test(parts[0] ?? "")) return parts.join(slash);
  return null;
}

export function pzCacheDir(playonHome: string): string {
  const sep = playonHome.includes("\\") ? "\\" : "/";
  const trimmed = playonHome.replace(/[\\/]+$/, "");
  return `${trimmed}${sep}Zomboid`;
}

/** Env the catalog start script and the managed wrapper turn into argv. */
export function pzProcessEnv(identity: PzLaunchIdentity): Record<string, string> {
  const env: Record<string, string> = {
    PLAYON_SERVER_NAME: identity.serverName,
    PLAYON_GAME_PORT: String(identity.gamePort),
    PLAYON_DIRECT_PORT: String(identity.directPort),
  };
  if (identity.playonHome) env.PLAYON_HOME = identity.playonHome;
  return env;
}

/**
 * Rewrite `.playon-start.env` so a managed wrapper cannot keep another
 * server's `PLAYON_SERVER_NAME` / `PLAYON_HOME`. Other keys (admin password,
 * flag name) stay.
 */
export function renderPzStartEnv(existing: string, identity: PzLaunchIdentity): string {
  const keys = new Map<string, string>();
  for (const line of existing.split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (!match?.[1]) continue;
    keys.set(match[1], match[2] ?? "");
  }
  const set = (key: string, value: string | undefined) => {
    if (!value) keys.delete(key);
    else keys.set(key, JSON.stringify(value));
  };
  set("PLAYON_SERVER_NAME", identity.serverName);
  set("PLAYON_GAME_PORT", String(identity.gamePort));
  set("PLAYON_DIRECT_PORT", String(identity.directPort));
  set("PLAYON_HOME", identity.playonHome);
  const lines = ["# Generated by PlayOn — this server's own launch identity"];
  for (const [key, value] of keys) lines.push(`${key}=${value}`);
  lines.push("");
  return lines.join("\n");
}

const PZ_IDENTITY_FLAGS = ["-cachedir", "-servername", "-port", "-udpport"] as const;

/** Drop identity flags so a skill's baked-in servertest / 16261 cannot survive. */
export function stripPzIdentityArgs(args: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const raw = args[i] ?? "";
    const lower = raw.toLowerCase();
    const flag = PZ_IDENTITY_FLAGS.find((item) => lower === item || lower.startsWith(`${item}=`));
    if (!flag) {
      out.push(raw);
      continue;
    }
    if (!lower.startsWith(`${flag}=`)) {
      const next = args[i + 1];
      if (next != null && !next.startsWith("-")) i++;
    }
  }
  return out;
}

export type PzNativeLaunch = {
  serverName: string;
  gamePort: number;
  directPort: number;
  cacheDir?: string;
};

/** Argv for a direct ProjectZomboid64 launch. No flag means no identity, not a default. */
export function withPzNativeArgs(args: readonly string[], launch: PzNativeLaunch | null): string[] {
  const stripped = stripPzIdentityArgs(args);
  if (!launch) return stripped;
  const next = [...stripped];
  if (launch.cacheDir) next.push("-cachedir", launch.cacheDir);
  next.push(
    "-servername",
    launch.serverName,
    "-port",
    String(launch.gamePort),
    "-udpport",
    String(launch.directPort),
  );
  return next;
}

function codeLines(text: string): string {
  return text
    .split(/\r?\n/)
    .filter((line) => {
      const trimmed = line.trim();
      return trimmed && !trimmed.startsWith("#") && !/^rem\b/i.test(trimmed) && !trimmed.startsWith("::");
    })
    .join("\n");
}

/**
 * Turn catalog fallbacks into a hard failure. The overlay in playon-games
 * still ships `:-servertest` / `:-16261`; Home rewrites the copy in the jail
 * before exec.
 */
export function neutralizePzStartScript(text: string): string {
  let next = text;
  const replacements: Array<[RegExp, string]> = [
    [
      /^NAME="\$\{PLAYON_SERVER_NAME:-servertest\}"\r?$/m,
      'NAME="${PLAYON_SERVER_NAME:?playon: PLAYON_SERVER_NAME is required}"',
    ],
    [
      /^PORT="\$\{PLAYON_GAME_PORT:-16261\}"\r?$/m,
      'PORT="${PLAYON_GAME_PORT:?playon: PLAYON_GAME_PORT is required}"',
    ],
    [
      /^UDPPORT="\$\{PLAYON_DIRECT_PORT:-16262\}"\r?$/m,
      'UDPPORT="${PLAYON_DIRECT_PORT:?playon: PLAYON_DIRECT_PORT is required}"',
    ],
    [
      /^if not defined PLAYON_SERVER_NAME set "PLAYON_SERVER_NAME=servertest"\r?$/m,
      [
        "if not defined PLAYON_SERVER_NAME (",
        "  echo playon: PLAYON_SERVER_NAME is required",
        "  exit /b 1",
        ")",
      ].join("\r\n"),
    ],
    [
      /^if not defined PLAYON_GAME_PORT set "PLAYON_GAME_PORT=16261"\r?$/m,
      [
        "if not defined PLAYON_GAME_PORT (",
        "  echo playon: PLAYON_GAME_PORT is required",
        "  exit /b 1",
        ")",
      ].join("\r\n"),
    ],
    [
      /^if not defined PLAYON_DIRECT_PORT set "PLAYON_DIRECT_PORT=16262"\r?$/m,
      [
        "if not defined PLAYON_DIRECT_PORT (",
        "  echo playon: PLAYON_DIRECT_PORT is required",
        "  exit /b 1",
        ")",
      ].join("\r\n"),
    ],
  ];
  for (const [pattern, replacement] of replacements) {
    next = next.replace(pattern, replacement);
  }
  return next;
}

/** Non-comment lines that would still launch someone else's name or the NZL ports. */
export function pzStartScriptProblem(text: string): string | null {
  const code = codeLines(text);
  if (code.includes("NewZombieLand3")) {
    return "start_config_hardcoded: start script names NewZombieLand3";
  }
  if (/PLAYON_SERVER_NAME:-servertest/.test(code) || /PLAYON_SERVER_NAME=servertest/.test(code)) {
    return "start_config_hardcoded: start script defaults the server name";
  }
  if (/PLAYON_GAME_PORT:-16261/.test(code) || /PLAYON_GAME_PORT=16261/.test(code)) {
    return "start_config_hardcoded: start script defaults the game port";
  }
  if (/PLAYON_DIRECT_PORT:-16262/.test(code) || /PLAYON_DIRECT_PORT=16262/.test(code)) {
    return "start_config_hardcoded: start script defaults the direct port";
  }
  if (/(?:^|[\s"'])-servername(?:[\s="']+)(?:servertest|NewZombieLand3)\b/.test(code)) {
    return "start_config_hardcoded: start script hardcodes -servername";
  }
  if (/(?:^|[\s"'])-port(?:[\s="']+)16261\b/.test(code)) {
    return "start_config_hardcoded: start script hardcodes -port 16261";
  }
  if (/(?:^|[\s"'])-udpport(?:[\s="']+)16262\b/.test(code)) {
    return "start_config_hardcoded: start script hardcodes -udpport 16262";
  }
  return null;
}
