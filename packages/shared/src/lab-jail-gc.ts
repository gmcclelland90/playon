/**
 * Orphan server-jail GC policy (#968).
 *
 * Home/node may purge a jail only when it has no DB row *and* a positive
 * lab-fixture signal. Named friend / live hosts (NZL, Hub, Frontier, …)
 * are never auto-deleted — including unmarked leftovers.
 */

/** Jail-relative marker written for disposable lab servers. */
export const LAB_FIXTURE_MARKER_REL = ".playon/lab-fixture";

const LAB_NAME_PREFIXES = [
  "lab-matrix-",
  "lab-llm-canary",
  "lab-soak-",
  "lab-polish-",
  "lab-join-",
] as const;

/** Live / friend names that must never be GC'd even if a lab flag is wrong. */
const PROTECTED_LIVE_NAME_RE =
  /zombieland|newzombie|\bnzl\b|frontier|\bhub\b|pzserver|friend/i;

export type OrphanJailDecision = "purge" | "keep";

export type OrphanJailIdentity = {
  serverName?: string | null;
  labFixture?: boolean | null;
};

export type OrphanJailPlanRow = {
  id: string;
  decision: OrphanJailDecision;
  reason: string;
  serverName?: string;
};

export function isLabFixtureServerName(name?: string | null): boolean {
  const n = (name ?? "").trim().toLowerCase();
  if (!n) return false;
  return LAB_NAME_PREFIXES.some((prefix) => n.startsWith(prefix));
}

export function isProtectedLiveServerName(name?: string | null): boolean {
  const n = (name ?? "").trim();
  if (!n) return false;
  return PROTECTED_LIVE_NAME_RE.test(n);
}

/** Extras persisted on `skill.json` so a later orphan GC can classify the jail. */
export function jailIdentityExtras(serverName: string): Record<string, unknown> {
  const name = serverName.trim();
  const extras: Record<string, unknown> = { serverName: name };
  if (isLabFixtureServerName(name)) extras.labFixture = true;
  return extras;
}

export function identityFromSkillMarker(raw: unknown): OrphanJailIdentity {
  if (!raw || typeof raw !== "object") return {};
  const o = raw as Record<string, unknown>;
  const serverName = typeof o.serverName === "string" ? o.serverName : undefined;
  return {
    ...(serverName ? { serverName } : {}),
    labFixture: o.labFixture === true,
  };
}

export function classifyOrphanJail(input: OrphanJailIdentity): {
  decision: OrphanJailDecision;
  reason: string;
} {
  const name = (input.serverName ?? "").trim();
  if (isProtectedLiveServerName(name)) {
    return { decision: "keep", reason: "protected_live_name" };
  }
  if (input.labFixture === true || isLabFixtureServerName(name)) {
    return { decision: "purge", reason: "lab_fixture" };
  }
  return { decision: "keep", reason: "no_lab_signal" };
}

/**
 * Diff on-disk jail ids against Home DB ids, then apply the lab-only purge rule.
 * Unknown / unnamed leftovers stay — never guess a friend server.
 */
export function planOrphanJailActions(input: {
  jailIds: readonly string[];
  keepIds: Iterable<string>;
  identityFor: (id: string) => OrphanJailIdentity;
}): OrphanJailPlanRow[] {
  const keep = new Set(Array.from(input.keepIds, (id) => String(id ?? "").trim()).filter(Boolean));
  const out: OrphanJailPlanRow[] = [];
  for (const rawId of input.jailIds) {
    const id = String(rawId ?? "").trim();
    if (!id) continue;
    if (keep.has(id)) {
      out.push({ id, decision: "keep", reason: "has_db_row" });
      continue;
    }
    const identity = input.identityFor(id) ?? {};
    const classified = classifyOrphanJail(identity);
    out.push({
      id,
      decision: classified.decision,
      reason: classified.reason,
      ...(identity.serverName ? { serverName: identity.serverName } : {}),
    });
  }
  return out;
}
