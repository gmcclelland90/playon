import { describe, expect, it } from "vitest";
import { decryptSecret, encryptSecret } from "./secrets.js";

describe("secrets", () => {
  it("roundtrips encrypt and decrypt", () => {
    const secret = "test-session-secret";
    const plaintext = "sk-live-abc123";
    const encoded = encryptSecret(secret, plaintext);
    expect(encoded).not.toContain(plaintext);
    expect(decryptSecret(secret, encoded)).toBe(plaintext);
  });
});
