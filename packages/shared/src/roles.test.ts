import { describe, expect, it } from "vitest";
import { roleAtLeast } from "./roles.js";

describe("roleAtLeast", () => {
  it("allows owner for admin-required actions", () => {
    expect(roleAtLeast("owner", "admin")).toBe(true);
  });

  it("denies player for operator actions", () => {
    expect(roleAtLeast("player", "operator")).toBe(false);
  });
});
