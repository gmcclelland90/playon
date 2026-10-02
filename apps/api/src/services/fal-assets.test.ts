import { describe, expect, it, vi } from "vitest";
import { encryptSecret } from "./secrets.js";
import {
  FAL_CUTOUT_MODEL,
  FalAssetsError,
  extensionForContentType,
  gameReadySize,
  generateFalAsset,
  normalizeFalAssetKind,
  placementHint,
  resolveFalApiKey,
  resolveFalModel,
  runFalQueue,
} from "./fal-assets.js";
import { decodePng, encodePng } from "./png-lite.js";

const Q = "https://queue.fal.run";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function queued(model: string, id: string): Response {
  return json({
    request_id: id,
    status_url: `${Q}/${model}/requests/${id}/status`,
    response_url: `${Q}/${model}/requests/${id}`,
    cancel_url: `${Q}/${model}/requests/${id}/cancel`,
  });
}

function solidPng(width: number, height: number, rgba: [number, number, number, number]): Uint8Array {
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) data.set(rgba, i * 4);
  return encodePng({ width, height, data });
}

const noSleep = async () => {};

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
    expect(extensionForContentType("audio/wav")).toBe("wav");
  });

  it("kinds and models are allowlisted", () => {
    expect(normalizeFalAssetKind(undefined)).toBe("image");
    expect(normalizeFalAssetKind("Icon")).toBe("icon");
    expect(() => normalizeFalAssetKind("video")).toThrow(FalAssetsError);
    expect(resolveFalModel("icon")).toBe("fal-ai/flux/schnell");
    expect(resolveFalModel("sound")).toBe("fal-ai/stable-audio");
    expect(() => resolveFalModel("image", "fal-ai/veo3")).toThrow(/fal_model_not_allowed/);
    expect(() => resolveFalModel("sound", "fal-ai/flux/schnell")).toThrow(/fal_model_not_allowed/);
  });

  it("gameReadySize picks per-dialect defaults and honours overrides", () => {
    expect(gameReadySize("icon", "project-zomboid")).toBe(32);
    expect(gameReadySize("icon", "minecraft-paper")).toBe(16);
    expect(gameReadySize("icon", "rust-oxide")).toBe(64);
    expect(gameReadySize("texture", "project-zomboid")).toBe(256);
    expect(gameReadySize("texture", "minecraft-paper", 64)).toBe(64);
    expect(gameReadySize("texture", null, 33)).toBe(256);
    expect(gameReadySize("image", "project-zomboid")).toBeNull();
    expect(placementHint("icon", "project-zomboid", "crate.png")).toContain("Item_crate.png");
  });

  it("runFalQueue submits with Key auth, polls, then fetches the result", async () => {
    const model = "fal-ai/flux/schnell";
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(queued(model, "r1"))
      .mockResolvedValueOnce(json({ status: "IN_QUEUE" }))
      .mockResolvedValueOnce(json({ status: "COMPLETED" }))
      .mockResolvedValueOnce(json({ images: [{ url: "https://v3.fal.media/a.png" }] }));
    const out = await runFalQueue({
      apiKey: "secret-key",
      model,
      input: { prompt: "a crate" },
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep: noSleep,
    });
    expect(out.images).toBeDefined();
    const [submitUrl, submitInit] = fetchImpl.mock.calls[0]!;
    expect(String(submitUrl)).toBe(`${Q}/${model}`);
    expect(submitInit.headers.Authorization).toBe("Key secret-key");
    expect(String(fetchImpl.mock.calls[3]![0])).toBe(`${Q}/${model}/requests/r1`);
  });

  it("runFalQueue refuses to send the key off the queue host", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      json({ status_url: "https://evil.example/status", response_url: `${Q}/x/requests/1` }),
    );
    await expect(
      runFalQueue({
        apiKey: "k",
        model: "fal-ai/flux/schnell",
        input: {},
        fetchImpl: fetchImpl as unknown as typeof fetch,
        sleep: noSleep,
      }),
    ).rejects.toMatchObject({ code: "fal_bad_response" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("runFalQueue times out and cancels", async () => {
    const model = "fal-ai/stable-audio";
    const fetchImpl = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      if (init?.method === "POST") return queued(model, "r2");
      if (init?.method === "PUT") return json({ status: "CANCELLATION_REQUESTED" }, 202);
      return json({ status: "IN_PROGRESS" });
    });
    await expect(
      runFalQueue({
        apiKey: "k",
        model,
        input: {},
        fetchImpl: fetchImpl as unknown as typeof fetch,
        sleep: noSleep,
        pollMs: 1000,
        timeoutMs: 3000,
      }),
    ).rejects.toMatchObject({ code: "fal_timeout" });
    expect(fetchImpl.mock.calls.some(([, init]) => init?.method === "PUT")).toBe(true);
  });

  it("runFalQueue surfaces a failed request", async () => {
    const model = "fal-ai/flux/schnell";
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(queued(model, "r3"))
      .mockResolvedValueOnce(json({ status: "COMPLETED", error: "nsfw", error_type: "content_policy" }));
    await expect(
      runFalQueue({
        apiKey: "k",
        model,
        input: {},
        fetchImpl: fetchImpl as unknown as typeof fetch,
        sleep: noSleep,
      }),
    ).rejects.toMatchObject({ code: "fal_failed" });
  });

  it("icon: generates, removes background, downscales to the PZ icon size", async () => {
    const source = solidPng(64, 48, [200, 100, 50, 255]);
    const cutoutUrl = "https://v3.fal.media/cut.png";
    const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      if (init?.method === "POST" && u.endsWith("/fal-ai/flux/schnell")) {
        const body = JSON.parse(String(init.body));
        expect(body.prompt).toContain("inventory icon");
        expect(body.output_format).toBe("png");
        return queued("fal-ai/flux/schnell", "g1");
      }
      if (init?.method === "POST" && u.endsWith(`/${FAL_CUTOUT_MODEL}`)) {
        expect(JSON.parse(String(init.body)).image_url).toBe("https://v3.fal.media/gen.png");
        return queued(FAL_CUTOUT_MODEL, "c1");
      }
      if (u.endsWith("/status")) return json({ status: "COMPLETED" });
      if (u.endsWith("/requests/g1")) return json({ images: [{ url: "https://v3.fal.media/gen.png" }] });
      if (u.endsWith("/requests/c1")) return json({ image: { url: cutoutUrl, content_type: "image/png" } });
      if (u === cutoutUrl) {
        expect((init?.headers as Record<string, string> | undefined)?.Authorization).toBeUndefined();
        return new Response(source, { headers: { "content-type": "image/png" } });
      }
      throw new Error(`unexpected ${u}`);
    });
    const out = await generateFalAsset({
      apiKey: "k",
      kind: "icon",
      prompt: "a rusty crowbar",
      dialect: "project-zomboid",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep: noSleep,
    });
    expect(out.steps).toEqual([FAL_CUTOUT_MODEL]);
    expect(out.width).toBe(32);
    expect(out.height).toBe(32);
    const decoded = decodePng(out.bytes);
    expect(decoded.width).toBe(32);
    expect(Array.from(decoded.data.subarray(0, 4))).toEqual([200, 100, 50, 255]);
  });

  it("sound: passes seconds_total and returns the clip as-is", async () => {
    const audio = new Uint8Array([82, 73, 70, 70]);
    const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      if (init?.method === "POST") {
        expect(JSON.parse(String(init.body)).seconds_total).toBe(47);
        return queued("fal-ai/stable-audio", "s1");
      }
      if (u.endsWith("/status")) return json({ status: "COMPLETED" });
      if (u.endsWith("/requests/s1")) {
        return json({ audio_file: { url: "https://v3.fal.media/a.wav", content_type: "audio/wav" } });
      }
      return new Response(audio, { headers: { "content-type": "audio/wav" } });
    });
    const out = await generateFalAsset({
      apiKey: "k",
      kind: "sound",
      prompt: "zombie groan",
      seconds: 300,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep: noSleep,
    });
    expect(out.contentType).toBe("audio/wav");
    expect(out.bytes).toEqual(audio);
  });

  it("texture refuses a non-PNG result", async () => {
    const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      if (init?.method === "POST") return queued("fal-ai/flux/schnell", "t1");
      if (u.endsWith("/status")) return json({ status: "COMPLETED" });
      if (u.endsWith("/requests/t1")) return json({ images: [{ url: "https://v3.fal.media/t.jpg" }] });
      return new Response(new Uint8Array([0xff, 0xd8, 0xff]), { headers: { "content-type": "image/jpeg" } });
    });
    await expect(
      generateFalAsset({
        apiKey: "k",
        kind: "texture",
        prompt: "mossy brick",
        fetchImpl: fetchImpl as unknown as typeof fetch,
        sleep: noSleep,
      }),
    ).rejects.toMatchObject({ code: "fal_unexpected_format" });
  });
});
