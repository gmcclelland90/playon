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
