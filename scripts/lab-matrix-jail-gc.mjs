/**
 * Lab/matrix helpers for node jail teardown checks and orphan GC (#968).
 */

export function jailListLooksGone(listing) {
  if (listing == null) return false;
  const err = String(listing.error ?? listing.message ?? "");
  if (/not_found/i.test(err)) return true;
  const entries = listing.result?.entries ?? listing.entries ?? [];
  return Array.isArray(entries) && entries.length === 0;
}

export function assertJailGone(listing, serverId) {
  if (jailListLooksGone(listing)) return;
  const entries = listing?.result?.entries ?? listing?.entries ?? [];
  const names = Array.isArray(entries) ? entries.map((e) => e.name).join(",") : "unknown";
  throw new Error(`jail_not_removed: ${serverId} entries=${names || "(present)"}`);
}

export function onlineNodeIds(nodesPayload) {
  const list = Array.isArray(nodesPayload)
    ? nodesPayload
    : Array.isArray(nodesPayload?.nodes)
      ? nodesPayload.nodes
      : [];
  return list
    .filter((n) => n && (n.status === "online" || n.presence === "online") && n.id)
    .map((n) => String(n.id));
}
