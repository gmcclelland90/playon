import path from "node:path";
import { describe, expect, it } from "vitest";
import { PathJailError, resolveInJail } from "./path-jail.js";

describe("resolveInJail", () => {
  const root = path.resolve("/tmp/playon-server");

  it("allows relative paths inside root", () => {
    const target = resolveInJail(root, "configs/server.cfg");
    expect(target.startsWith(root)).toBe(true);
  });

  it("blocks .. escapes", () => {
    expect(() => resolveInJail(root, "../etc/passwd")).toThrow(PathJailError);
  });
});
