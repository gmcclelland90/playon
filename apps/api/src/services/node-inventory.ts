import type { NodeContainerInventory, NodeProcessInventory, ResourceUsage } from "@playon/shared";
import { usageForManagedServer } from "@playon/shared";

/**
 * Last read-only container / process inventory from each node's heartbeat.
 * Never used to create, start, stop, or remove a workload.
 */
const containersByNode = new Map<string, NodeContainerInventory[]>();
const processesByNode = new Map<string, NodeProcessInventory[]>();

export function recordNodeContainers(
  nodeId: string,
  containers: NodeContainerInventory[] | undefined,
): void {
  if (containers === undefined) return;
  containersByNode.set(nodeId, containers);
}

export function recordNodeProcesses(
  nodeId: string,
  processes: NodeProcessInventory[] | undefined,
): void {
  if (processes === undefined) return;
  processesByNode.set(nodeId, processes);
}

export function nodeContainers(nodeId: string): NodeContainerInventory[] {
  return containersByNode.get(nodeId) ?? [];
}

export function nodeProcesses(nodeId: string): NodeProcessInventory[] {
  return processesByNode.get(nodeId) ?? [];
}

export function serverUsageFromInventory(
  serverId: string,
  nodeId: string | null | undefined,
  runtimeMode: string | null | undefined,
): ResourceUsage {
  if (!nodeId) return {};
  return usageForManagedServer(
    serverId,
    runtimeMode,
    nodeContainers(nodeId),
    nodeProcesses(nodeId),
  );
}

export function forgetNodeContainers(nodeId: string): void {
  containersByNode.delete(nodeId);
  processesByNode.delete(nodeId);
}

export function clearNodeContainers(): void {
  containersByNode.clear();
  processesByNode.clear();
}
