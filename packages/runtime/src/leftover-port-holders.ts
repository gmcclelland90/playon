import { playonContainerName } from "@playon/shared";
import type { HostContainer } from "./docker-inventory.js";
import type { HostPortNeed } from "./host-port-bind.js";

/** Sidecar that must never be reaped with game leftovers. */
export const PROTECTED_PLAYON_CONTAINERS = new Set(["playon-ollama"]);

/** Friend / NZL live names — never reap even if inventory is stale. */
export const PROTECTED_CONTAINER_NAME_RE = /zombieland|newzombie/i;

/**
 * Isolated lab-matrix temp roots (`/tmp/playon-lab-matrix-*`) must not reap
 * unknown `playon-*` containers — durable Home on the same host may own them.
 */
export function isIsolatedLabMatrixRoot(dataRoot: string | null | undefined): boolean {
  if (!dataRoot) return false;
  return /(^|[\\/])playon-lab-matrix-/.test(dataRoot.replace(/\\/g, "/"));
}

export function isProtectedPlayonContainer(
  name: string,
  protectNames: Iterable<string> = [],
): boolean {
  const trimmed = name.trim();
  if (!trimmed.startsWith("playon-")) return true;
  if (PROTECTED_PLAYON_CONTAINERS.has(trimmed)) return true;
  if (PROTECTED_CONTAINER_NAME_RE.test(trimmed)) return true;
  const protect = protectNames instanceof Set ? protectNames : new Set(protectNames);
  return protect.has(trimmed);
}

export function protectNamesFromServerIds(serverIds: Iterable<string>): Set<string> {
  const names = new Set<string>(PROTECTED_PLAYON_CONTAINERS);
  for (const id of serverIds) {
    const trimmed = String(id ?? "").trim();
    if (trimmed) names.add(playonContainerName(trimmed));
  }
  return names;
}

export function containerHoldsHostPort(
  container: HostContainer,
  port: HostPortNeed,
): boolean {
  return (container.ports ?? []).some(
    (p) => p.host === port.host && (!p.protocol || p.protocol === port.protocol),
  );
}

/**
 * PlayOn leftovers that may be force-removed.
 * When `protectListLoaded` is false, only `knownLeftoverNames` are reapable
 * (stale matrix temp-root server ids) — never guess.
 */
export function leftoverPlayonContainers(
  containers: HostContainer[],
  opts: {
    protectNames?: Iterable<string>;
    protectListLoaded: boolean;
    knownLeftoverNames?: Iterable<string>;
    ports?: HostPortNeed[];
  },
): HostContainer[] {
  const protect = new Set(opts.protectNames ?? []);
  for (const name of PROTECTED_PLAYON_CONTAINERS) protect.add(name);
  const known = new Set(opts.knownLeftoverNames ?? []);
  return containers.filter((c) => {
    if (!c.name.startsWith("playon-")) return false;
    if (isProtectedPlayonContainer(c.name, protect)) return false;
    if (!opts.protectListLoaded && !known.has(c.name)) return false;
    if (opts.ports?.length && !opts.ports.some((p) => containerHoldsHostPort(c, p))) {
      return false;
    }
    return true;
  });
}
