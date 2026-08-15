import type { NodeContainerInventory } from "@playon/shared";

/**
 * Last read-only container inventory from each node's heartbeat.
 * Never used to create, start, stop, or remove a container.
 */
const byNode = new Map<string, NodeContainerInventory[]>();

export function recordNodeContainers(
  nodeId: string,
  containers: NodeContainerInventory[] | undefined,
): void {
  if (containers === undefined) return;
  byNode.set(nodeId, containers);
}

export function nodeContainers(nodeId: string): NodeContainerInventory[] {
  return byNode.get(nodeId) ?? [];
}

export function forgetNodeContainers(nodeId: string): void {
  byNode.delete(nodeId);
}

export function clearNodeContainers(): void {
  byNode.clear();
}
