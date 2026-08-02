import { describe, expect, it } from "vitest";
import { redactJson, redactString, redactValue } from "./redaction.js";

describe("redaction", () => {
  it("redacts sensitive object keys", () => {
    expect(
      redactValue({
        skillName: "games.minecraft-paper",
        apiKey: "super-secret",
        nested: { password: "hunter2", ok: true },
      }),
    ).toEqual({
      skillName: "games.minecraft-paper",
      apiKey: "[REDACTED]",
      nested: { password: "[REDACTED]", ok: true },
    });
  });

  it("redacts inline secret-looking strings", () => {
    expect(redactString("Bearer abcdefghijklmnopqrstuvwxyz0123")).toContain("[REDACTED]");
    expect(redactString("sk-abcdefghijklmnopqrstuvwxyz")).toContain("[REDACTED]");
  });

  it("produces safe JSON for audit storage", () => {
    const json = redactJson({ authorization: "Bearer secret-token-value-1234", port: 25565 });
    expect(json).toContain("[REDACTED]");
    expect(json).not.toContain("secret-token");
    expect(json).toContain("25565");
  });
});
