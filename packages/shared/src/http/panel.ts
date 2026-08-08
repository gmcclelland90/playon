import { z } from "zod";

/**
 * Player-panel request contracts. The panel is the one unauthenticated surface,
 * so its body shape is pinned here and validated before anything reaches the
 * service.
 */
export const PanelInputRequestSchema = z.object({
  blockId: z.string().optional(),
  serverId: z.string().optional(),
  type: z.enum(["readiness", "vote"]),
  payload: z.record(z.unknown()).default({}),
});

export type PanelInputRequest = z.infer<typeof PanelInputRequestSchema>;
