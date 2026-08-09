import { z } from "zod";

export const PanelBlockTypeSchema = z.enum([
  "server_status",
  "join_info",
  "client_setup",
  "guide",
  "vote",
  "readiness",
  "announcement",
  "file_drop",
  "discovery",
]);

export type PanelBlockType = z.infer<typeof PanelBlockTypeSchema>;

export const PanelBlockSchema = z.object({
  id: z.string().min(1),
  serverId: z.string().nullable().optional(),
  type: PanelBlockTypeSchema,
  title: z.string().min(1),
  body: z.record(z.unknown()).default({}),
  sortOrder: z.number().int().default(0),
  updatedAt: z.string().datetime().optional(),
});

export type PanelBlock = z.infer<typeof PanelBlockSchema>;

const HttpUrlSchema = z
  .string()
  .url()
  .refine((u) => /^https?:\/\//i.test(u), { message: "URL must be http or https" });

export const PanelGuideBodySchema = z.object({
  summary: z.string().optional(),
  notes: z.string().optional(),
  instructions: z.string().optional(),
  steps: z.array(z.string()).optional(),
  links: z
    .array(
      z.object({
        label: z.string(),
        url: z.string(),
      }),
    )
    .optional(),
  url: z.string().optional(),
});
export type PanelGuideBody = z.infer<typeof PanelGuideBodySchema>;

export const PanelAnnouncementBodySchema = z.object({
  summary: z.string().optional(),
  notes: z.string().optional(),
  level: z.enum(["info", "warn", "fun"]).optional(),
});
export type PanelAnnouncementBody = z.infer<typeof PanelAnnouncementBodySchema>;

export const PanelFileDropBodySchema = z.object({
  url: HttpUrlSchema,
  label: z.string().optional(),
  sha256: z.string().optional(),
});
export type PanelFileDropBody = z.infer<typeof PanelFileDropBodySchema>;

export const PanelDiscoveryBodySchema = z.object({
  summary: z.string().optional(),
  suggestions: z.array(
    z.object({
      title: z.string(),
      detail: z.string().optional(),
      skillName: z.string().optional(),
    }),
  ),
});
export type PanelDiscoveryBody = z.infer<typeof PanelDiscoveryBodySchema>;

export const PanelVoteBodySchema = z.object({
  summary: z.string().optional(),
  options: z.array(z.string()).optional(),
  choices: z.array(z.string()).optional(),
});
export type PanelVoteBody = z.infer<typeof PanelVoteBodySchema>;

export const PanelReadinessBodySchema = z.object({
  summary: z.string().optional(),
  label: z.string().optional(),
});
export type PanelReadinessBody = z.infer<typeof PanelReadinessBodySchema>;

export const PanelJoinInfoBodySchema = z.object({
  address: z.string().optional(),
  port: z.union([z.number(), z.string()]).optional(),
  endpoint: z.string().optional(),
  connectCommand: z.string().optional(),
  steamConnectUrl: z.string().optional(),
  game: z.string().optional(),
});
export type PanelJoinInfoBody = z.infer<typeof PanelJoinInfoBodySchema>;

export const PanelClientSetupBodySchema = z.object({
  notes: z.string().optional(),
  instructions: z.string().optional(),
  steps: z.array(z.string()).optional(),
});
export type PanelClientSetupBody = z.infer<typeof PanelClientSetupBodySchema>;

export const PanelServerStatusBodySchema = z.object({
  status: z.string().optional(),
  players: z.union([z.number(), z.string()]).optional(),
  maxPlayers: z.union([z.number(), z.string()]).optional(),
  map: z.string().optional(),
  mode: z.string().optional(),
  playerList: z.array(z.string()).optional(),
  runtime: z.string().optional(),
  game: z.string().optional(),
});
export type PanelServerStatusBody = z.infer<typeof PanelServerStatusBodySchema>;

const BODY_SCHEMAS = {
  guide: PanelGuideBodySchema,
  announcement: PanelAnnouncementBodySchema,
  file_drop: PanelFileDropBodySchema,
  discovery: PanelDiscoveryBodySchema,
  vote: PanelVoteBodySchema,
  readiness: PanelReadinessBodySchema,
  join_info: PanelJoinInfoBodySchema,
  client_setup: PanelClientSetupBodySchema,
  server_status: PanelServerStatusBodySchema,
} as const;

function asRecord(body: unknown): Record<string, unknown> {
  if (body && typeof body === "object" && !Array.isArray(body)) {
    return body as Record<string, unknown>;
  }
  return {};
}

function bestEffortString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function bestEffortStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out = value.filter((v): v is string => typeof v === "string");
  return out.length ? out : undefined;
}

/** Normalize vote aliases so either options or choices can drive the UI. */
function normalizeVoteBody(body: PanelVoteBody): PanelVoteBody {
  const options = body.options ?? body.choices;
  const choices = body.choices ?? body.options;
  return {
    ...body,
    ...(options ? { options } : {}),
    ...(choices ? { choices } : {}),
  };
}

/**
 * Safe-parse a panel block body for its type.
 * On success returns the typed/normalized object; on failure returns the original
 * body object with best-effort known fields preserved.
 */
export function parsePanelBody(
  type: PanelBlockType,
  body: unknown,
): Record<string, unknown> {
  const raw = asRecord(body);
  const schema = BODY_SCHEMAS[type];
  const parsed = schema.safeParse(raw);
  if (parsed.success) {
    if (type === "vote") {
      return normalizeVoteBody(parsed.data as PanelVoteBody) as Record<string, unknown>;
    }
    return parsed.data as Record<string, unknown>;
  }

  // Best-effort fallback: keep original keys plus any string fields we recognize.
  const fallback: Record<string, unknown> = { ...raw };
  const summary = bestEffortString(raw.summary);
  const notes = bestEffortString(raw.notes);
  const instructions = bestEffortString(raw.instructions);
  const steps = bestEffortStringArray(raw.steps);
  if (summary !== undefined) fallback.summary = summary;
  if (notes !== undefined) fallback.notes = notes;
  if (instructions !== undefined) fallback.instructions = instructions;
  if (steps !== undefined) fallback.steps = steps;
  if (type === "vote") {
    const options = bestEffortStringArray(raw.options) ?? bestEffortStringArray(raw.choices);
    const choices = bestEffortStringArray(raw.choices) ?? bestEffortStringArray(raw.options);
    if (options) fallback.options = options;
    if (choices) fallback.choices = choices;
  }
  if (type === "file_drop" && typeof raw.url === "string") {
    fallback.url = raw.url;
  }
  return fallback;
}
