import { describe, expect, it } from "vitest";
import { MAKE_A_MOD_DRAFT } from "./make-a-mod";

describe("MAKE_A_MOD_DRAFT", () => {
  it("names the jailed loop tools without auto-sending", () => {
    expect(MAKE_A_MOD_DRAFT.startsWith("Make a mod that")).toBe(true);
    expect(MAKE_A_MOD_DRAFT).toContain("mods_scaffold");
    expect(MAKE_A_MOD_DRAFT).toContain("mods_deploy");
    expect(MAKE_A_MOD_DRAFT).toContain("mods_errors");
    expect(MAKE_A_MOD_DRAFT).toContain("mods-src");
  });
});
