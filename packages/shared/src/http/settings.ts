import { z } from "zod";
import { LLM_PRESET_IDS } from "../llm-presets.js";

/**
 * Request contracts for the settings routes — LLM provider, Ollama jobs, node
 * settings, MCP access tokens and the Vultr OAuth callback. They live here
 * rather than inline in `app.ts` so the control plane and web client validate
 * the same shape, and so a schema failure renders as the shared 400 envelope.
 */

const nonEmpty = z.string().min(1);

/**
 * `provider` predates presets and stays accepted for older clients; the route
 * resolves whichever arrives against the stored settings. Neither being present
 * is the one thing this schema rejects outright.
 */
export const LlmSettingsPutRequestSchema = z
  .object({
    preset: z.enum(LLM_PRESET_IDS).optional(),
    /** @deprecated Prefer preset; kept for older clients. */
    provider: z.enum(["openai_compatible", "ollama"]).optional(),
    baseUrl: z.string().optional(),
    model: z.string().optional(),
    /** An empty string clears the stored key rather than leaving it untouched. */
    apiKey: z.string().optional(),
  })
  .refine((body) => Boolean(body.preset || body.provider), {
    message: "preset_or_provider_required",
  });

export type LlmSettingsPutRequest = z.infer<typeof LlmSettingsPutRequestSchema>;

/** Both Ollama jobs fall back to the stored base URL when the body omits one. */
export const OllamaInstallRequestSchema = z.object({
  baseUrl: z.string().optional(),
});

export type OllamaInstallRequest = z.infer<typeof OllamaInstallRequestSchema>;

export const OllamaPullRequestSchema = z.object({
  model: nonEmpty,
  baseUrl: z.string().optional(),
});

export type OllamaPullRequest = z.infer<typeof OllamaPullRequestSchema>;

export const NodeSettingsPutRequestSchema = z.object({
  localComputeEnabled: z.boolean(),
});

export type NodeSettingsPutRequest = z.infer<typeof NodeSettingsPutRequestSchema>;

export const CreateAccessTokenRequestSchema = z.object({
  name: z.string().min(1).max(80).default("MCP token"),
  autoApproveConfirms: z.boolean().optional(),
});

export type CreateAccessTokenRequest = z.infer<typeof CreateAccessTokenRequestSchema>;

/** Posted by the OAuth relay or the loopback redirect — not a browser session. */
export const VultrOAuthCallbackRequestSchema = z.object({
  state: nonEmpty,
  code: nonEmpty,
});

export type VultrOAuthCallbackRequest = z.infer<typeof VultrOAuthCallbackRequestSchema>;
