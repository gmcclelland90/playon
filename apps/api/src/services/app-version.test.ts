import { describe, expect, it } from "vitest";
import { readAppVersion } from "./app-version.js";

describe("readAppVersion", () => {
  it("reads a semver from the workspace package.json", () => {
    const v = readAppVersion();
    expect(v).toMatch(/^\d+\.\d+\.\d+/);
  });
});
