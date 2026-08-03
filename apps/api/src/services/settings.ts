import { eq } from "drizzle-orm";
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

export type LlmProvider = "openai_compatible" | "ollama";

export interface LlmSettings {
  provider: LlmProvider;
  baseUrl?: string;
  model?: string;
  apiKeyEncrypted?: string;
}

export interface LlmSettingsPublic {
  provider: LlmProvider;
  baseUrl?: string;
  model?: string;
  hasApiKey: boolean;
}

export function toPublicLlmSettings(settings: LlmSettings): LlmSettingsPublic {
  return {
    provider: settings.provider,
    baseUrl: settings.baseUrl,
    model: settings.model,
    hasApiKey: Boolean(settings.apiKeyEncrypted),
  };
}

export const CLOUD_SETTINGS_KEY = "cloud.vultr";
export const SKILLS_CATALOG_KEY = "skills.catalog";

export type VultrCloudSettings = {
  accessTokenEncrypted?: string;
  refreshTokenEncrypted?: string;
  expiresAt?: string;
  connectState?: string;
  codeVerifier?: string;
};

export type SkillsCatalogSettings = {
  /** Default https://playon.games/skills/index.json */
  catalogUrl: string;
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
