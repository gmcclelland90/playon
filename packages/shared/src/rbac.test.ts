import { describe, expect, it } from "vitest";
import { can } from "./rbac.js";

describe("rbac can()", () => {
  it("lets operators manage servers but not LLM settings or chat", () => {
    expect(can("operator", "servers.manage")).toBe(true);
    expect(can("operator", "settings.llm")).toBe(false);
    expect(can("operator", "chat.agent")).toBe(false);
    expect(can("operator", "snapshots.restore")).toBe(false);
  });

  it("lets admins chat and restore; only owner manages users", () => {
    expect(can("admin", "chat.agent")).toBe(true);
    expect(can("admin", "snapshots.restore")).toBe(true);
    expect(can("admin", "users.manage")).toBe(false);
    expect(can("owner", "users.manage")).toBe(true);
  });
});
