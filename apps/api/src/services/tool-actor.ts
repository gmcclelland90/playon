import { AsyncLocalStorage } from "node:async_hooks";
import { roleAtLeast, type Role } from "@playon/shared";

/**
 * Caller identity for one tool invocation.
 * MCP sets this from the access token's user. In-app chat and watchers leave
 * it unset — those entry points are already gated before a tool runs.
 */
export type ToolActor = {
  userId: string;
  role: Role | null;
};

const storage = new AsyncLocalStorage<ToolActor>();

export function runWithToolActor<T>(actor: ToolActor, fn: () => T): T {
  return storage.run(actor, fn);
}

export function currentToolActor(): ToolActor | undefined {
  return storage.getStore();
}

/**
 * `nodes_list` matches `GET /api/nodes`: operator and above.
 * No actor means a host path (watcher, test, in-process) that is not an MCP token.
 * An MCP token whose user is missing or below operator is refused.
 */
export function assertOperatorToolActor(): void {
  const actor = currentToolActor();
  if (!actor) return;
  if (!actor.role || !roleAtLeast(actor.role, "operator")) {
    throw new Error("forbidden");
  }
}
