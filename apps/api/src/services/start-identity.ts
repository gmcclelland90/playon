/**
 * Start-time isolation for servers on one node (#1016).
 *
 * A managed `game/.playon-start.env` carries the launch identity
 * (`PLAYON_SERVER_NAME` → `-servername`, `PLAYON_HOME` → userdata/cachedir).
 * Those values were captured from whatever install was managed — so a clone
 * of NZL could inherit `NewZombieLand3`, generate a fresh default world, and
 * bind the live server's 16261. Every start must prove it only touches its
 * own world, home, and game port.
 */
import path from "node:path";

export type StartLaunchIdentity = {
  /** Value passed to the game's server-name flag (PZ `-servername`). */
  launchName?: string;
  /** Node-absolute userdata root exported as HOME / PZ `-cachedir`. */
  playonHome?: string;
};

export type StartPeer = {
  id: string;
  name: string;
  status: string;
  launchName?: string;
  gamePort?: number | null;
};

export type StartIsolationInput = {
  id: string;
  identity: StartLaunchIdentity;
  /** This server's PZ-style `Server/<world>.ini` basenames (no extension). */
  worldIniNames: readonly string[];
  gamePort?: number | null;
  /** Other servers on the same node. */
  peers: readonly StartPeer[];
};

function unquote(raw: string): string {
  const v = raw.trim();
  if (v.startsWith('"') && v.endsWith('"') && v.length >= 2) {
    try {
      return String(JSON.parse(v));
    } catch {
      return v.slice(1, -1);
    }
  }
  if (v.startsWith("'") && v.endsWith("'") && v.length >= 2) return v.slice(1, -1);
  return v;
}

/** Parse the KEY=value lines `buildManagedStartEnv` writes (comments ignored). */
export function parseManagedStartEnv(text: string): StartLaunchIdentity {
  const vars = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (!m?.[1]) continue;
    vars.set(m[1], unquote(m[2] ?? ""));
  }
  const launchName = vars.get("PLAYON_SERVER_NAME")?.trim();
  const playonHome = vars.get("PLAYON_HOME")?.trim();
  return {
    ...(launchName ? { launchName } : {}),
    ...(playonHome ? { playonHome } : {}),
  };
}

/** True when a node-absolute path sits inside this server's own jail. */
export function pathBelongsToServer(absPath: string, serverId: string): boolean {
  const parts = absPath.split(/[\\/]+/).filter(Boolean);
  const idx = parts.lastIndexOf(serverId);
  return idx >= 0 && parts[idx - 1] === "servers";
}

/** Pick the `<launchName>.ini` from jail-relative ini paths (case-insensitive). */
export function iniRelForLaunchName(
  rels: readonly string[],
  launchName: string | undefined,
): string | undefined {
  if (!launchName) return undefined;
  const want = `${launchName}.ini`.toLowerCase();
  return rels.find((rel) => path.posix.basename(rel.replace(/\\/g, "/")).toLowerCase() === want);
}

/** PZ world inis (`.../Zomboid/Server/<world>.ini`) → world names. */
export function worldIniNamesFromRels(rels: readonly string[]): string[] {
  const out: string[] = [];
  for (const rel of rels) {
    const norm = rel.replace(/\\/g, "/");
    if (!/(^|\/)Server\/[^/]+\.ini$/i.test(norm)) continue;
    out.push(path.posix.basename(norm).replace(/\.ini$/i, ""));
  }
  return out;
}

const sameName = (a: string | undefined, b: string | undefined): boolean =>
  !!a && !!b && a.trim().toLowerCase() === b.trim().toLowerCase();

const ACTIVE = new Set(["running", "starting"]);

/**
 * Refusal reason for a start that would share another server's world, home,
 * or game port — or null when this server is isolated.
 */
export function startIsolationViolation(input: StartIsolationInput): string | null {
  const { id, identity } = input;
  if (identity.playonHome && !pathBelongsToServer(identity.playonHome, id)) {
    return `start_identity_foreign_home: PLAYON_HOME ${identity.playonHome} is outside servers/${id}`;
  }

  const launchName = identity.launchName;
  if (launchName) {
    if (
      input.worldIniNames.length > 0 &&
      !input.worldIniNames.some((n) => sameName(n, launchName))
    ) {
      return (
        `start_identity_world_missing: launch name "${launchName}" has no Server/${launchName}.ini ` +
        `in this server (found ${input.worldIniNames.join(", ")}); it would start a fresh default world`
      );
    }
    for (const peer of input.peers) {
      if (peer.id === id) continue;
      if (sameName(peer.launchName, launchName) || sameName(peer.name, launchName)) {
        return `start_identity_collision: launch name "${launchName}" belongs to server ${peer.name} (${peer.id})`;
      }
    }
  }

  if (input.gamePort != null && input.gamePort > 0) {
    for (const peer of input.peers) {
      if (peer.id === id || !ACTIVE.has(peer.status)) continue;
      if (peer.gamePort === input.gamePort) {
        return `start_port_collision: game port ${input.gamePort} is in use by ${peer.status} server ${peer.name} (${peer.id})`;
      }
    }
  }
  return null;
}
