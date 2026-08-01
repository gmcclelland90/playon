import { z } from "zod";

export const RoleSchema = z.enum(["owner", "admin", "operator", "player"]);
export type Role = z.infer<typeof RoleSchema>;

export const ROLE_RANK: Record<Role, number> = {
  owner: 100,
  admin: 80,
  operator: 40,
  player: 10,
};

export function roleAtLeast(actual: Role, required: Role): boolean {
  return ROLE_RANK[actual] >= ROLE_RANK[required];
}
