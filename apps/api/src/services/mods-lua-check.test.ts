import { describe, expect, it } from "vitest";
import {
  FIXTURE_SERIALIZE_BAD,
  FIXTURE_SERIALIZE_GOOD,
  checkPzLuaSources,
} from "./mods-lua-check.js";

describe("checkPzLuaSources", () => {
  it("fails the classic serializeInventory getFavoriteHeight + InventoryItemFactory fixture", () => {
    const result = checkPzLuaSources({
      "media/lua/shared/Utils.lua": FIXTURE_SERIALIZE_BAD,
    });
    expect(result.ok).toBe(false);
    expect(result.scannedFiles).toBe(1);
    expect(result.findings.some((f) => f.rule === "no_getFavoriteHeight_call")).toBe(
      true,
    );
    expect(result.findings.some((f) => f.rule === "prefer_instanceItem")).toBe(true);
  });

  it("passes the B42-safe inventory roundtrip-style fixture", () => {
    const result = checkPzLuaSources({
      "media/lua/shared/Utils.lua": FIXTURE_SERIALIZE_GOOD,
    });
    expect(result.ok).toBe(true);
    expect(result.findings.filter((f) => f.severity === "error")).toHaveLength(0);
  });

  it("ignores non-lua files", () => {
    const result = checkPzLuaSources({
      "mod.info": "name=x\n",
      "readme.md": "item:getFavoriteHeight()\n",
    });
    expect(result.scannedFiles).toBe(0);
    expect(result.ok).toBe(true);
  });
});
