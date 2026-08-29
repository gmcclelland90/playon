/**
 * Per-instance game port from server.ini-style files (Project Zomboid
 * DefaultPort / UDPPort). Skill metadata `ports.game.default` is only a
 * fallback when the instance has no bind of its own.
 *
 * Do not change catalog games.project-zomboid default 16261 (NZL / first
 * server). Extra instances (Hub 16271, Frontier 16265) write their own
 * DefaultPort; join/health/reap must read that.
 */

export type InstanceIniPorts = {
  defaultPort: number | null;
  udpPort: number | null;
};

/** Common jail-relative dirs where PZ writes <name>.ini. */
export const INSTANCE_INI_HINT_DIRS = [
  "home/Zomboid/Server",
  "Zomboid/Server",
  "Server",
  "game/Zomboid/Server",
] as const;

export function parseIniIntKey(text: string, key: string): number | null {
  const re = new RegExp(`^\\s*${key}\\s*=\\s*(\\d+)\\s*(?:[;#].*)?$`, "im");
  const match = text.match(re);
  if (!match?.[1]) return null;
  const port = Number(match[1]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return port;
}

export function parseInstanceIniPorts(text: string): InstanceIniPorts {
  return {
    defaultPort: parseIniIntKey(text, "DefaultPort"),
    udpPort: parseIniIntKey(text, "UDPPort"),
  };
}

/** Steam/game port first (DefaultPort); RakNet UDPPort only when DefaultPort is absent. */
export function instanceGamePortFromIniText(text: string): number | null {
  const parsed = parseInstanceIniPorts(text);
  return parsed.defaultPort ?? parsed.udpPort;
}

/** First DefaultPort across files wins; else first UDPPort. */
export function instanceGamePortFromIniTexts(texts: readonly string[]): number | null {
  let udpFallback: number | null = null;
  for (const text of texts) {
    const parsed = parseInstanceIniPorts(text);
    if (parsed.defaultPort != null) return parsed.defaultPort;
    if (udpFallback == null && parsed.udpPort != null) udpFallback = parsed.udpPort;
  }
  return udpFallback;
}
