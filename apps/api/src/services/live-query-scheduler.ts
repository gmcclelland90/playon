import type { PanelService } from "./panel.js";
import { publishServerPanel } from "./server-panel.js";
import type { ServerQueryService } from "./server-query.js";
import type { ServerService } from "./servers.js";

/**
 * Periodically refresh live query stats into auto server_status panel blocks.
 * Disabled when intervalMs <= 0.
 */
export class LiveQueryScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(
    private readonly servers: ServerService,
    private readonly panel: PanelService,
    private readonly queries: ServerQueryService,
    private readonly intervalMs = Number(process.env.PLAYON_LIVE_QUERY_INTERVAL_MS ?? 20_000),
  ) {}

  start(): void {
    if (this.intervalMs <= 0 || this.timer) return;
    this.timer = setInterval(() => {
      void this.tick();
    }, this.intervalMs);
    this.timer.unref?.();
    console.log(`live query scheduler: every ${this.intervalMs}ms`);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick(): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    let updated = 0;
    try {
      const list = await this.servers.list();
      for (const server of list) {
        if (server.status !== "running" && server.status !== "starting") continue;
        try {
          const live = await this.queries.queryServer(server.id);
          await publishServerPanel(
            this.servers,
            this.panel,
            server.id,
            server.status === "starting" ? "starting" : "running",
            live,
          );
          updated++;
        } catch {
          // keep scheduler alive
        }
      }
      return updated;
    } finally {
      this.running = false;
    }
  }
}
