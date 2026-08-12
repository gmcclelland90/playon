import { eq } from "drizzle-orm";
import {
  getLlmPreset,
  inferLlmPreset,
  isLlmPresetId,
  type LlmPresetId,
  type LlmTransport,
} from "@playon/shared";
import type { Db } from "../db/client.js";
import { settings } from "../db/schema.js";

export async function getSetting<T>(db: Db, key: string): Promise<T | null> {
  const rows = await db.select().from(settings).where(eq(settings.key, key)).limit(1);
  if (!rows[0]) return null;
  return JSON.parse(rows[0].valueJson) as T;
}

export async function setSetting<T>(db: Db, key: string, value: T): Promise<void> {
  const valueJson = JSON.stringify(value);
  const existing = await db.select().from(settings).where(eq(settings.key, key)).limit(1);
  if (existing[0]) {
    await db.update(settings).set({ valueJson }).where(eq(settings.key, key));
  } else {
    await db.insert(settings).values({ key, valueJson });
  }
}

export const LLM_SETTINGS_KEY = "llm";

/** @deprecated Prefer LlmTransport / preset — kept for stored JSON shape. */
export type LlmProvider = LlmTransport;

export interface LlmSettings {
  provider: LlmTransport;
  preset?: LlmPresetId;
  baseUrl?: string;
  model?: string;
  apiKeyEncrypted?: string;
}

export interface LlmSettingsPublic {
  provider: LlmTransport;
  preset: LlmPresetId;
  baseUrl?: string;
  model?: string;
  hasApiKey: boolean;
}

export function resolveLlmPreset(settings: LlmSettings): LlmPresetId {
  return inferLlmPreset({
    provider: settings.provider,
    preset: settings.preset,
    baseUrl: settings.baseUrl,
  });
}

export function toPublicLlmSettings(settings: LlmSettings): LlmSettingsPublic {
  const preset = resolveLlmPreset(settings);
  return {
    provider: settings.provider,
    preset,
    baseUrl: settings.baseUrl,
    model: settings.model,
    hasApiKey: Boolean(settings.apiKeyEncrypted),
  };
}

export function llmSettingsFromPut(body: {
  preset?: string;
  provider?: string;
  baseUrl?: string;
  model?: string;
}): Pick<LlmSettings, "provider" | "preset" | "baseUrl" | "model"> {
  const presetId: LlmPresetId =
    body.preset && isLlmPresetId(body.preset)
      ? body.preset
      : inferLlmPreset({
          provider: body.provider,
          baseUrl: body.baseUrl,
        });
  const preset = getLlmPreset(presetId);
  const baseUrl =
    preset.baseUrlEditable
      ? body.baseUrl?.trim() || preset.baseUrl || undefined
      : preset.baseUrl || body.baseUrl?.trim() || undefined;
  if (preset.baseUrlEditable && !baseUrl) {
    throw new Error("llm_base_url_required");
  }
  if (!body.model?.trim() && !preset.defaultModel) {
    throw new Error("llm_model_required");
  }
  return {
    provider: preset.transport,
    preset: presetId,
    baseUrl,
    model: body.model?.trim() || preset.defaultModel || undefined,
  };
}

export const CLOUD_SETTINGS_KEY = "cloud.vultr";
export const SKILLS_CATALOG_KEY = "skills.catalog";
export const NODE_SETTINGS_KEY = "nodes";
export const WG_HOME_SETTINGS_KEY = "cloud.wireguard.home";

export type VultrCloudSettings = {
  accessTokenEncrypted?: string;
  refreshTokenEncrypted?: string;
  expiresAt?: string;
  connectState?: string;
  codeVerifier?: string;
};

export type SkillsCatalogSettings = {
  /** Default https://playon.games/packages/index.json */
  catalogUrl: string;
};

/** Home compute + overlay bookkeeping. */
export type NodeSettings = {
  /** When false, Local is hidden from placement (control-plane-only). Default true. */
  localComputeEnabled: boolean;
  /** Next host octet for 10.77.0.N cloud overlay assignments (starts at 2). */
  nextOverlayHost?: number;
};

export type WgHomeSettings = {
  publicKey: string;
  privateKeyEncrypted: string;
};

export const DEFAULT_NODE_SETTINGS: NodeSettings = {
  localComputeEnabled: true,
  nextOverlayHost: 2,
};

export function toPublicCloudSettings(stored: VultrCloudSettings | null): {
  provider: "vultr";
  connected: boolean;
  expiresAt?: string;
} {
  return {
    provider: "vultr",
    connected: Boolean(stored?.accessTokenEncrypted),
    expiresAt: stored?.expiresAt,
  };
}

export function toPublicNodeSettings(stored: NodeSettings | null): {
  localComputeEnabled: boolean;
} {
  return {
    localComputeEnabled: stored?.localComputeEnabled ?? true,
  };
}
