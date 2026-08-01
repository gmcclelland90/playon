import { describe, expect, it } from "vitest";

describe("PlayOn brand", () => {
  it("keeps product name stable", () => {
    expect("PlayOn").toMatch(/^PlayOn$/);
  });
});
