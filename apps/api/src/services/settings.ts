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
export const LANCACHE_SETTINGS_KEY = "lancache";

const GIB = 1024 ** 3;

/** Fleet LAN content cache (BYO + managed lancachenet). */
export type LancacheSettings = {
  enabled: boolean;
  /** BYO or resolved party cache IPv4. */
  cacheIp?: string;
  /** Agents attempt Steam CDN hosts-file pin to cacheIp. */
  pinSteamcmd: boolean;
  /** Soft warn when node free disk is below this (bytes). */
  warnFreeDiskBytes: number;
  /** Soft warn when managed cache dir exceeds this (bytes). */
  warnCacheDirBytes: number;
  /** Node running managed monolithic stack; null/omit = BYO-only. */
  partyNodeId?: string | null;
  /** Also start lancache-dns when managed. */
  manageDns: boolean;
  /** Managed cache data directory on the party node. */
  dataPath?: string;
};

export type LancacheSettingsPublic = LancacheSettings & {
  /** Tip sheet for operators (DHCP / DNS). */
  tipSheet: string[];
  diskWarn: boolean;
};

export const DEFAULT_LANCACHE_SETTINGS: LancacheSettings = {
  enabled: false,
  pinSteamcmd: false,
  warnFreeDiskBytes: 100 * GIB,
  warnCacheDirBytes: 500 * GIB,
  partyNodeId: null,
  manageDns: false,
};

export const LANCACHE_TIP_SHEET: string[] = [
  "Point LAN DHCP DNS at the cache IP (or enable PlayOn-managed lancache-dns on the party node).",
  "LANCache serves HTTP on ports 80/443 — avoid conflicts with other host services.",
  "Windows PlayOn nodes can use a cache but only Linux+Docker nodes can run the managed stack.",
  "Hosts-file SteamCMD pin covers known Steam CDN names; full wildcard CDN coverage needs DNS.",
  "Each game server still keeps its own install directory — caching saves WAN bandwidth, not disk.",
];

export function toPublicLancacheSettings(
  stored: LancacheSettings | null,
  opts?: { minFreeDiskBytes?: number | null },
): LancacheSettingsPublic {
  const s = { ...DEFAULT_LANCACHE_SETTINGS, ...stored };
  const free = opts?.minFreeDiskBytes;
  const diskWarn =
    Boolean(s.enabled) &&
    free != null &&
    Number.isFinite(free) &&
    free < s.warnFreeDiskBytes;
  return {
    ...s,
    tipSheet: LANCACHE_TIP_SHEET,
    diskWarn,
  };
}

function parseCacheIp(raw: string | null | undefined, clear: boolean): string | undefined {
  if (clear || raw === null || raw === "") return undefined;
  if (raw === undefined) return undefined;
  const cacheIp = raw.trim();
  if (!cacheIp) return undefined;
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(cacheIp)) {
    throw new Error("lancache_cache_ip_invalid");
  }
  const parts = cacheIp.split(".").map(Number);
  if (parts.some((n) => n > 255)) throw new Error("lancache_cache_ip_invalid");
  return cacheIp;
}

export function lancacheSettingsFromPut(
  body: {
    enabled?: boolean;
    cacheIp?: string | null;
    pinSteamcmd?: boolean;
    warnFreeDiskBytes?: number;
    warnCacheDirBytes?: number;
    partyNodeId?: string | null;
    manageDns?: boolean;
    dataPath?: string | null;
  },
  existing: LancacheSettings = DEFAULT_LANCACHE_SETTINGS,
): LancacheSettings {
  const cacheIpSpecified = "cacheIp" in body;
  const cacheIp = cacheIpSpecified
    ? parseCacheIp(body.cacheIp, body.cacheIp === null || body.cacheIp === "")
    : existing.cacheIp;
  const dataPathSpecified = "dataPath" in body;
  return {
    enabled: body.enabled ?? existing.enabled,
    cacheIp,
    pinSteamcmd: body.pinSteamcmd ?? existing.pinSteamcmd,
    warnFreeDiskBytes:
      body.warnFreeDiskBytes != null && body.warnFreeDiskBytes > 0
        ? body.warnFreeDiskBytes
        : existing.warnFreeDiskBytes,
    warnCacheDirBytes:
      body.warnCacheDirBytes != null && body.warnCacheDirBytes > 0
        ? body.warnCacheDirBytes
        : existing.warnCacheDirBytes,
    partyNodeId:
      body.partyNodeId === undefined
        ? existing.partyNodeId
        : body.partyNodeId?.trim() || null,
    manageDns: body.manageDns ?? existing.manageDns,
    dataPath: dataPathSpecified
      ? body.dataPath === null || body.dataPath === ""
        ? undefined
        : body.dataPath?.trim() || undefined
      : existing.dataPath,
  };
}

/** Agent-facing slice of fleet lancache settings (heartbeat response). */
export function toLancacheAgentConfig(stored: LancacheSettings | null): {
  enabled: boolean;
  cacheIp?: string;
  pinSteamcmd: boolean;
} {
  const s = { ...DEFAULT_LANCACHE_SETTINGS, ...stored };
  return {
    enabled: s.enabled,
    ...(s.cacheIp ? { cacheIp: s.cacheIp } : {}),
    pinSteamcmd: s.pinSteamcmd,
  };
}

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
