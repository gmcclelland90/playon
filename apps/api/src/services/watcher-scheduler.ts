import type { WatcherEngine } from "./watcher-engine.js";

/**
 * 5s tick for schedule due times + health/query watcher polls.
 */
export class WatcherScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(
    private readonly engine: WatcherEngine,
    private readonly intervalMs = Number(process.env.PLAYON_WATCHER_TICK_MS ?? 5_000),
  ) {}

  start(): void {
    if (this.intervalMs <= 0 || this.timer) return;
    this.engine.start();
    this.timer = setInterval(() => {
      void this.tick();
    }, this.intervalMs);
    this.timer.unref?.();
    console.log(`watcher scheduler: every ${this.intervalMs}ms`);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.engine.stop();
  }

  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.engine.tickSchedule();
      await this.engine.tickHealthAndQuery();
      await this.engine.tickWorkshop();
    } catch {
      // keep scheduler alive
    } finally {
      this.running = false;
    }
  }
}
