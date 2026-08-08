import type { Role } from "./roles.js";
import { roleAtLeast } from "./roles.js";

/** Named capabilities used by API + UI affordances. */
export type Capability =
  | "servers.manage"
  | "panel.read"
  | "chat.agent"
  | "settings.llm"
  | "confirm.host"
  | "users.manage"
  | "snapshots.restore"
  | "skills.package"
  | "watchers.read"
  | "watchers.manage";

const CAPABILITY_MIN_ROLE: Record<Capability, Role> = {
  "servers.manage": "operator",
  "panel.read": "player",
  "chat.agent": "admin",
  "settings.llm": "admin",
  "confirm.host": "admin",
  "users.manage": "owner",
  "snapshots.restore": "admin",
  "skills.package": "admin",
  "watchers.read": "operator",
  "watchers.manage": "admin",
};

export function can(role: Role, capability: Capability): boolean {
  return roleAtLeast(role, CAPABILITY_MIN_ROLE[capability]);
}

export function minRoleFor(capability: Capability): Role {
  return CAPABILITY_MIN_ROLE[capability];
}
