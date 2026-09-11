import {
  identityFromSkillMarker,
  LAB_FIXTURE_MARKER_REL,
  planOrphanJailActions,
  type OrphanJailIdentity,
  type OrphanJailPlanRow,
} from "@playon/shared";

export type OrphanJailGcReport = {
  nodeId: string;
  dryRun: boolean;
  purged: string[];
  kept: Array<{ id: string; reason: string; serverName?: string }>;
  errors: Array<{ id: string; error: string }>;
};

export type OrphanJailGcDeps = {
  nodeId: string;
  listKeepIds: () => Promise<Iterable<string>>;
  listJailIds: () => Promise<string[]>;
  readIdentity: (jailId: string) => Promise<OrphanJailIdentity>;
  stopJail: (jailId: string) => Promise<void>;
  removeJail: (jailId: string) => Promise<void>;
  jailStillPresent: (jailId: string) => Promise<boolean>;
};

export function parseSkillJsonIdentity(content: string): OrphanJailIdentity {
  try {
    return identityFromSkillMarker(JSON.parse(content) as unknown);
  } catch {
    return {};
  }
}

export function mergeJailIdentity(
  skill: OrphanJailIdentity,
  labFixtureName?: string | null,
): OrphanJailIdentity {
  const fromFile = (labFixtureName ?? "").trim();
  return {
    serverName: skill.serverName ?? (fromFile || undefined),
    labFixture: skill.labFixture === true || Boolean(fromFile),
  };
}

export { LAB_FIXTURE_MARKER_REL };

/**
 * List on-disk jails with no Home row and purge only lab fixtures.
 * Friend / live / unmarked leftovers are reported as kept.
 */
export async function gcOrphanJails(
  deps: OrphanJailGcDeps,
  opts?: { dryRun?: boolean },
): Promise<OrphanJailGcReport> {
  const dryRun = Boolean(opts?.dryRun);
  const keepIds = await deps.listKeepIds();
  const jailIds = await deps.listJailIds();
  const identities = new Map<string, OrphanJailIdentity>();
  for (const id of jailIds) {
    identities.set(id, await deps.readIdentity(id).catch(() => ({})));
  }
  const plan = planOrphanJailActions({
    jailIds,
    keepIds,
    identityFor: (id) => identities.get(id) ?? {},
  });

  const purged: string[] = [];
  const kept: OrphanJailGcReport["kept"] = [];
  const errors: OrphanJailGcReport["errors"] = [];

  for (const row of plan) {
    if (row.decision === "keep") {
      if (row.reason !== "has_db_row") {
        kept.push({
          id: row.id,
          reason: row.reason,
          ...(row.serverName ? { serverName: row.serverName } : {}),
        });
      }
      continue;
    }
    if (dryRun) {
      purged.push(row.id);
      continue;
    }
    try {
      await deps.stopJail(row.id);
      await deps.removeJail(row.id);
      if (await deps.jailStillPresent(row.id)) {
        throw new Error(`jail_not_removed: ${row.id}`);
      }
      purged.push(row.id);
    } catch (err) {
      errors.push({
        id: row.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { nodeId: deps.nodeId, dryRun, purged, kept, errors };
}

export function summarizeOrphanPlan(plan: OrphanJailPlanRow[]): {
  purgeIds: string[];
  keepIds: string[];
} {
  return {
    purgeIds: plan.filter((r) => r.decision === "purge").map((r) => r.id),
    keepIds: plan.filter((r) => r.decision === "keep").map((r) => r.id),
  };
}
