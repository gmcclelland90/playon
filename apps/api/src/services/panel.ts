import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { PanelBlockTypeSchema } from "@playon/shared";
import { z } from "zod";
import type { Db } from "../db/client.js";
import { panelBlocks } from "../db/schema.js";
import type { EventHub } from "./event-hub.js";

export const PublishBlockSchema = z.object({
  type: PanelBlockTypeSchema,
  title: z.string().min(1),
  body: z.record(z.unknown()).default({}),
  sortOrder: z.number().int().default(0),
});

export interface PanelBlockRecord {
  id: string;
  serverId: string | null;
  type: string;
  title: string;
  body: Record<string, unknown>;
  sortOrder: number;
  updatedAt: Date;
}

function toRecord(row: typeof panelBlocks.$inferSelect): PanelBlockRecord {
  return {
    id: row.id,
    serverId: row.serverId,
    type: row.type,
    title: row.title,
    body: JSON.parse(row.bodyJson) as Record<string, unknown>,
    sortOrder: row.sortOrder,
    updatedAt: row.updatedAt,
  };
}

export class PanelService {
  constructor(
    private readonly db: Db,
    private readonly events?: EventHub,
  ) {}

  async list(serverId?: string): Promise<PanelBlockRecord[]> {
    const rows = serverId
      ? await this.db.select().from(panelBlocks).where(eq(panelBlocks.serverId, serverId))
      : await this.db.select().from(panelBlocks);
    return rows.map(toRecord).sort((a, b) => a.sortOrder - b.sortOrder);
  }

  private async notifyUpdated(): Promise<void> {
    if (!this.events) return;
    const blocks = await this.list();
    this.events.publish({
      type: "panel.updated",
      blocks: blocks.map((b) => {
        const type = PanelBlockTypeSchema.safeParse(b.type);
        return {
          id: b.id,
          serverId: b.serverId,
          type: type.success ? type.data : "announcement",
          title: b.title,
          body: b.body,
          sortOrder: b.sortOrder,
          updatedAt: b.updatedAt.toISOString(),
        };
      }),
    });
  }

  async publish(args: {
    serverId?: string;
    blocks: Array<z.infer<typeof PublishBlockSchema>>;
  }): Promise<PanelBlockRecord[]> {
    const now = new Date();
    const published: PanelBlockRecord[] = [];

    for (const block of args.blocks) {
      const parsed = PublishBlockSchema.parse(block);
      const id = nanoid();
      await this.db.insert(panelBlocks).values({
        id,
        serverId: args.serverId ?? null,
        type: parsed.type,
        title: parsed.title,
        bodyJson: JSON.stringify(parsed.body),
        sortOrder: parsed.sortOrder,
        updatedAt: now,
      });
      const rows = await this.db.select().from(panelBlocks).where(eq(panelBlocks.id, id)).limit(1);
      if (rows[0]) published.push(toRecord(rows[0]));
    }

    await this.notifyUpdated();
    return published;
  }

  /** Replace all panel blocks for a server (used on start/stop status updates). */
  async replaceForServer(
    serverId: string,
    blocks: Array<z.infer<typeof PublishBlockSchema>>,
  ): Promise<PanelBlockRecord[]> {
    await this.db.delete(panelBlocks).where(eq(panelBlocks.serverId, serverId));
    return this.publish({ serverId, blocks });
  }


  async recordInput(_args: {
    blockId?: string;
    type: "readiness" | "vote";
    payload: Record<string, unknown>;
  }): Promise<{ ok: true; recordedAt: string }> {
    return { ok: true, recordedAt: new Date().toISOString() };
  }
}
