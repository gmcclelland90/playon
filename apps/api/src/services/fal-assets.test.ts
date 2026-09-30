import { describe, expect, it, vi } from "vitest";
import { encryptSecret } from "./secrets.js";
import {
  extensionForContentType,
  generateFalImage,
  resolveFalApiKey,
} from "./fal-assets.js";

describe("fal-assets", () => {
  it("resolveFalApiKey decrypts or returns null", () => {
    const secret = "test-session-secret-32chars-min!!";
    expect(resolveFalApiKey(null, secret)).toBeNull();
    expect(resolveFalApiKey({}, secret)).toBeNull();
    const enc = encryptSecret(secret, "fal-test-key");
    expect(resolveFalApiKey({ apiKeyEncrypted: enc }, secret)).toBe("fal-test-key");
  });

  it("extensionForContentType maps common types", () => {
    expect(extensionForContentType("image/png")).toBe("png");
    expect(extensionForContentType("image/jpeg")).toBe("jpg");
    expect(extensionForContentType("image/webp")).toBe("webp");
  });

  it("generateFalImage posts with Key auth and downloads bytes", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ images: [{ url: "https://cdn.example/a.png", content_type: "image/png" }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(new Uint8Array([1, 2, 3, 4]), {
          status: 200,
          headers: { "content-type": "image/png" },
        }),
      );
    const out = await generateFalImage({
      apiKey: "secret-key",
      prompt: "a crate",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(out.bytes).toEqual(new Uint8Array([1, 2, 3, 4]));
    expect(out.model).toBe("fal-ai/flux/schnell");
    const firstCall = fetchImpl.mock.calls[0];
    expect(String(firstCall[0])).toContain("fal.run/fal-ai/flux/schnell");
    expect(firstCall[1].headers.Authorization).toBe("Key secret-key");
  });
});
