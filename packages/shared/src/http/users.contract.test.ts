import { describe, expect, it } from "vitest";
import { CreateUserRequestSchema } from "./users.js";

describe("user route request contract", () => {
  it("enforces the username and password floors", () => {
    const result = CreateUserRequestSchema.safeParse({
      username: "ab",
      password: "short",
      role: "operator",
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.path.join("."))).toEqual([
      "username",
      "password",
    ]);
  });

  it("refuses to mint an owner or a player through this route", () => {
    expect(
      CreateUserRequestSchema.safeParse({
        username: "second",
        password: "password123",
        role: "owner",
      }).success,
    ).toBe(false);
    expect(
      CreateUserRequestSchema.parse({
        username: "second",
        password: "password123",
        role: "admin",
      }).role,
    ).toBe("admin");
  });
});
