import { describe, expect, it } from "vitest";
import { hashPassword, verifyPassword } from "./password.js";

describe("password hashing", () => {
  it("round-trips", () => {
    const encoded = hashPassword("correct-horse");
    expect(verifyPassword("correct-horse", encoded)).toBe(true);
    expect(verifyPassword("wrong", encoded)).toBe(false);
  });
});
