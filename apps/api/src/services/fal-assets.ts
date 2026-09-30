/**
 * Host BYO fal.ai asset generation (#998). Never logs the API key.
 * Writes only under mods-src/<modId>/ when the caller supplies a jailed path.
 */
import { decryptSecret } from "./secrets.js";
import type { FalSettings } from "./settings.js";

export const FAL_DEFAULT_MODEL = "fal-ai/flux/schnell";
export const FAL_RUN_BASE = "https://fal.run";

export class FalAssetsError extends Error {
  constructor(
    message: string,
    readonly code:
      | "fal_key_missing"
      | "fal_http_error"
      | "fal_bad_response"
      | "fal_download_failed",
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

export type FalGenerateResult = {
  model: string;
  imageUrl: string;
  contentType: string;
  bytes: Uint8Array;
};

/** Call fal.run text-to-image and download the first image bytes. */
export async function generateFalImage(opts: {
  apiKey: string;
  prompt: string;
  model?: string;
  fetchImpl?: typeof fetch;
}): Promise<FalGenerateResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const model = (opts.model?.trim() || FAL_DEFAULT_MODEL).replace(/^\/+/, "");
  const res = await fetchImpl(`${FAL_RUN_BASE}/${model}`, {
    method: "POST",
    headers: {
      Authorization: `Key ${opts.apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ prompt: opts.prompt }),
  });
  if (!res.ok) {
    // Do not include response body if it might echo auth — keep generic.
    throw new FalAssetsError(`fal_http_${res.status}`, "fal_http_error");
  }
  const json = (await res.json()) as {
    images?: Array<{ url?: string; content_type?: string }>;
  };
  const imageUrl = json.images?.[0]?.url;
  if (!imageUrl || typeof imageUrl !== "string") {
    throw new FalAssetsError("fal_missing_image_url", "fal_bad_response");
  }
  const img = await fetchImpl(imageUrl);
  if (!img.ok) {
    throw new FalAssetsError(`fal_download_${img.status}`, "fal_download_failed");
  }
  const buf = new Uint8Array(await img.arrayBuffer());
  const contentType =
    json.images?.[0]?.content_type ||
    img.headers.get("content-type") ||
    "image/png";
  return { model, imageUrl, contentType, bytes: buf };
}

export function extensionForContentType(contentType: string): string {
  const ct = contentType.toLowerCase();
  if (ct.includes("jpeg") || ct.includes("jpg")) return "jpg";
  if (ct.includes("webp")) return "webp";
  if (ct.includes("gif")) return "gif";
  return "png";
}
