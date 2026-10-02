/**
 * Host BYO fal.ai asset generation (#998, game-ready slice under #988).
 * Never logs the API key, and only ever sends it to the fal queue host.
 * Writes only under mods-src/<modId>/ when the caller supplies a jailed path.
 */
import { decodePng, encodePng, isPng, PngLiteError, squareDownscale } from "./png-lite.js";
import { decryptSecret } from "./secrets.js";
import type { FalSettings } from "./settings.js";

export const FAL_DEFAULT_MODEL = "fal-ai/flux/schnell";
export const FAL_QUEUE_BASE = "https://queue.fal.run";
const FAL_QUEUE_HOST = "queue.fal.run";
export const FAL_CUTOUT_MODEL = "fal-ai/birefnet";
export const FAL_SOUND_MODEL = "fal-ai/stable-audio";

/**
 * image   — raw text-to-image, full resolution
 * sprite  — background removed (transparent PNG), full resolution
 * icon    — sprite downscaled to the game's item-icon size
 * texture — opaque square downscaled to the game's texture size
 * sound   — short text-to-audio clip
 */
export const FAL_ASSET_KINDS = ["image", "sprite", "icon", "texture", "sound"] as const;
export type FalAssetKind = (typeof FAL_ASSET_KINDS)[number];

/** Allowlisted models per kind; first entry is the default. Hosts pay fal, so no open-ended model ids. */
export const FAL_ALLOWED_MODELS: Record<FalAssetKind, readonly string[]> = {
  image: [FAL_DEFAULT_MODEL, "fal-ai/flux/dev"],
  sprite: [FAL_DEFAULT_MODEL, "fal-ai/flux/dev"],
  icon: [FAL_DEFAULT_MODEL, "fal-ai/flux/dev"],
  texture: [FAL_DEFAULT_MODEL, "fal-ai/flux/dev"],
  sound: [FAL_SOUND_MODEL],
};

export const FAL_ASSET_SIZES = [16, 32, 64, 128, 256, 512, 1024] as const;

const ICON_SIZE: Record<string, number> = {
  "project-zomboid": 32,
  "minecraft-paper": 16,
  "terraria-tmod": 32,
  factorio: 64,
};
const TEXTURE_SIZE: Record<string, number> = {
  "minecraft-paper": 16,
};

const PROMPT_SUFFIX: Partial<Record<FalAssetKind, string>> = {
  sprite: "single centered object, plain background, game sprite",
  icon: "single centered object, plain background, game inventory icon, clear silhouette",
  texture: "seamless tileable texture, flat even lighting, top-down",
};

const MAX_DOWNLOAD_BYTES = 25 * 1024 * 1024;
const DEFAULT_SOUND_SECONDS = 5;
const MAX_SOUND_SECONDS = 47;

export class FalAssetsError extends Error {
  constructor(
    message: string,
    readonly code:
      | "fal_key_missing"
      | "fal_model_not_allowed"
      | "fal_bad_kind"
      | "fal_http_error"
      | "fal_failed"
      | "fal_timeout"
      | "fal_bad_response"
      | "fal_download_failed"
      | "fal_download_too_large"
      | "fal_unexpected_format",
  ) {
    super(message);
    this.name = "FalAssetsError";
  }
}

export function resolveFalApiKey(
  settings: FalSettings | null,
  sessionSecret: string,
): string | null {
  if (!settings?.apiKeyEncrypted) return null;
  try {
    const key = decryptSecret(sessionSecret, settings.apiKeyEncrypted).trim();
    return key || null;
  } catch {
    return null;
  }
}

export function normalizeFalAssetKind(raw: unknown): FalAssetKind {
  if (raw === undefined || raw === null || raw === "") return "image";
  const kind = String(raw).trim().toLowerCase();
  if ((FAL_ASSET_KINDS as readonly string[]).includes(kind)) return kind as FalAssetKind;
  throw new FalAssetsError(`fal_bad_kind: ${kind}`, "fal_bad_kind");
}

export function resolveFalModel(kind: FalAssetKind, raw?: string): string {
  const allowed = FAL_ALLOWED_MODELS[kind];
  const model = (raw?.trim() || allowed[0]!).replace(/^\/+/, "");
  if (!allowed.includes(model)) {
    throw new FalAssetsError(
      `fal_model_not_allowed: ${model} (allowed for ${kind}: ${allowed.join(", ")})`,
      "fal_model_not_allowed",
    );
  }
  return model;
}

/** Target square size for icon/texture kinds; null means keep full resolution. */
export function gameReadySize(
  kind: FalAssetKind,
  dialect: string | null | undefined,
  override?: number,
): number | null {
  if (kind !== "icon" && kind !== "texture") return null;
  if (override && (FAL_ASSET_SIZES as readonly number[]).includes(override)) return override;
  const table = kind === "icon" ? ICON_SIZE : TEXTURE_SIZE;
  return table[dialect ?? ""] ?? (kind === "icon" ? 64 : 256);
}

/** Where the agent should copy the asset so the game actually loads it. */
export function placementHint(
  kind: FalAssetKind,
  dialect: string | null | undefined,
  baseName: string,
): string | undefined {
  const stem = baseName.replace(/\.[^.]+$/, "");
  if (dialect === "project-zomboid") {
    if (kind === "icon") {
      return `Copy to media/textures/Item_${stem}.png and set Icon = ${stem} in the item script.`;
    }
    if (kind === "texture" || kind === "sprite") return `Copy under media/textures/ for PZ to load it.`;
    if (kind === "sound") return `Copy under media/sound/ and declare it in a media/scripts sound block.`;
  }
  if (dialect === "minecraft-paper" && kind !== "sound") {
    return "Paper plugins cannot ship textures; this needs a client resource pack (clientNeed manual).";
  }
  return undefined;
}

type Sleep = (ms: number) => Promise<void>;
const defaultSleep: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function assertQueueUrl(raw: unknown): string {
  if (typeof raw !== "string") throw new FalAssetsError("fal_missing_queue_url", "fal_bad_response");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new FalAssetsError("fal_bad_queue_url", "fal_bad_response");
  }
  // The key rides on these requests; never follow a queue URL off fal's queue host.
  if (url.protocol !== "https:" || url.hostname !== FAL_QUEUE_HOST) {
    throw new FalAssetsError("fal_bad_queue_url", "fal_bad_response");
  }
  return url.toString();
}

/** Submit to fal's queue, poll until COMPLETED, return the model's result JSON. */
export async function runFalQueue(opts: {
  apiKey: string;
  model: string;
  input: Record<string, unknown>;
  fetchImpl?: typeof fetch;
  sleep?: Sleep;
  pollMs?: number;
  timeoutMs?: number;
}): Promise<Record<string, unknown>> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const sleep = opts.sleep ?? defaultSleep;
  const pollMs = opts.pollMs ?? 1000;
  const timeoutMs = opts.timeoutMs ?? 5 * 60_000;
  const auth = { Authorization: `Key ${opts.apiKey}` };

  const submit = await fetchImpl(`${FAL_QUEUE_BASE}/${opts.model}`, {
    method: "POST",
    headers: { ...auth, "content-type": "application/json" },
    body: JSON.stringify(opts.input),
  });
  // Never include response bodies in errors in case they echo auth.
  if (!submit.ok) throw new FalAssetsError(`fal_http_${submit.status}`, "fal_http_error");
  const queued = (await submit.json()) as Record<string, unknown>;
  const statusUrl = assertQueueUrl(queued.status_url);
  const responseUrl = assertQueueUrl(queued.response_url);
  const cancelUrl = typeof queued.cancel_url === "string" ? queued.cancel_url : null;

  let waited = 0;
  for (;;) {
    const res = await fetchImpl(statusUrl, { headers: auth });
    if (!res.ok) throw new FalAssetsError(`fal_status_http_${res.status}`, "fal_http_error");
    const status = (await res.json()) as { status?: string; error?: string; error_type?: string };
    if (status.error) {
      throw new FalAssetsError(`fal_failed: ${status.error_type ?? "error"}`, "fal_failed");
    }
    if (status.status === "COMPLETED") break;
    if (waited >= timeoutMs) {
      if (cancelUrl) {
        try {
          await fetchImpl(assertQueueUrl(cancelUrl), { method: "PUT", headers: auth });
        } catch {
          // Best effort; the timeout is what the caller needs to see.
        }
      }
      throw new FalAssetsError(`fal_timeout_${Math.round(timeoutMs / 1000)}s`, "fal_timeout");
    }
    await sleep(pollMs);
    waited += pollMs;
  }

  const result = await fetchImpl(responseUrl, { headers: auth });
  if (!result.ok) throw new FalAssetsError(`fal_result_http_${result.status}`, "fal_http_error");
  return (await result.json()) as Record<string, unknown>;
}

type FalMedia = { url: string; contentType?: string };

/** First media file in a fal result: images[0], image, audio_file or audio. */
export function pickFalMedia(result: Record<string, unknown>): FalMedia {
  const candidates = [
    Array.isArray(result.images) ? result.images[0] : undefined,
    result.image,
    result.audio_file,
    result.audio,
  ];
  for (const c of candidates) {
    if (c && typeof c === "object" && typeof (c as { url?: unknown }).url === "string") {
      const media = c as { url: string; content_type?: unknown };
      return {
        url: media.url,
        contentType: typeof media.content_type === "string" ? media.content_type : undefined,
      };
    }
  }
  throw new FalAssetsError("fal_missing_media_url", "fal_bad_response");
}

async function downloadMedia(
  media: FalMedia,
  fetchImpl: typeof fetch,
): Promise<{ bytes: Uint8Array; contentType: string }> {
  // CDN download: no Authorization header.
  const res = await fetchImpl(media.url);
  if (!res.ok) throw new FalAssetsError(`fal_download_${res.status}`, "fal_download_failed");
  const declared = Number(res.headers.get("content-length") ?? 0);
  if (declared > MAX_DOWNLOAD_BYTES) {
    throw new FalAssetsError("fal_download_too_large", "fal_download_too_large");
  }
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.byteLength > MAX_DOWNLOAD_BYTES) {
    throw new FalAssetsError("fal_download_too_large", "fal_download_too_large");
  }
  const contentType =
    media.contentType || res.headers.get("content-type") || "application/octet-stream";
  return { bytes, contentType };
}

export type FalAssetResult = {
  kind: FalAssetKind;
  model: string;
  /** Extra models run after the main one (e.g. background removal). */
  steps: string[];
  contentType: string;
  bytes: Uint8Array;
  width?: number;
  height?: number;
};

/** Generate one asset of `kind` and make it game-ready for `dialect`. */
export async function generateFalAsset(opts: {
  apiKey: string;
  kind: FalAssetKind;
  prompt: string;
  model?: string;
  dialect?: string | null;
  size?: number;
  seconds?: number;
  fetchImpl?: typeof fetch;
  sleep?: Sleep;
  pollMs?: number;
  timeoutMs?: number;
}): Promise<FalAssetResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const kind = opts.kind;
  const model = resolveFalModel(kind, opts.model);
  const queue = {
    apiKey: opts.apiKey,
    fetchImpl,
    sleep: opts.sleep,
    pollMs: opts.pollMs,
    timeoutMs: opts.timeoutMs,
  };

  if (kind === "sound") {
    const seconds = Math.min(
      MAX_SOUND_SECONDS,
      Math.max(1, Math.round(opts.seconds ?? DEFAULT_SOUND_SECONDS)),
    );
    const result = await runFalQueue({
      ...queue,
      model,
      input: { prompt: opts.prompt, seconds_total: seconds },
    });
    const { bytes, contentType } = await downloadMedia(pickFalMedia(result), fetchImpl);
    return { kind, model, steps: [], contentType, bytes };
  }

  const suffix = PROMPT_SUFFIX[kind];
  const generated = await runFalQueue({
    ...queue,
    model,
    input: {
      prompt: suffix ? `${opts.prompt}, ${suffix}` : opts.prompt,
      image_size: "square_hd",
      output_format: "png",
      num_images: 1,
    },
  });
  let media = pickFalMedia(generated);
  const steps: string[] = [];

  if (kind === "sprite" || kind === "icon") {
    // BiRefNet reads the image straight from fal's CDN; nothing is re-uploaded.
    const cutout = await runFalQueue({
      ...queue,
      model: FAL_CUTOUT_MODEL,
      input: { image_url: media.url, output_format: "png" },
    });
    media = pickFalMedia(cutout);
    steps.push(FAL_CUTOUT_MODEL);
  }

  const downloaded = await downloadMedia(media, fetchImpl);
  const target = gameReadySize(kind, opts.dialect, opts.size);
  if (target === null) {
    return { kind, model, steps, contentType: downloaded.contentType, bytes: downloaded.bytes };
  }
  if (!isPng(downloaded.bytes)) {
    throw new FalAssetsError("fal_expected_png", "fal_unexpected_format");
  }
  try {
    const resized = squareDownscale(decodePng(downloaded.bytes), target);
    return {
      kind,
      model,
      steps,
      contentType: "image/png",
      bytes: encodePng(resized),
      width: resized.width,
      height: resized.height,
    };
  } catch (err) {
    if (err instanceof PngLiteError) {
      throw new FalAssetsError(err.message, "fal_unexpected_format");
    }
    throw err;
  }
}

export function extensionForContentType(contentType: string): string {
  const ct = contentType.toLowerCase();
  if (ct.includes("jpeg") || ct.includes("jpg")) return "jpg";
  if (ct.includes("webp")) return "webp";
  if (ct.includes("gif")) return "gif";
  if (ct.includes("wav")) return "wav";
  if (ct.includes("mpeg") || ct.includes("mp3")) return "mp3";
  if (ct.includes("ogg")) return "ogg";
  return "png";
}
