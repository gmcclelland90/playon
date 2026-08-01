import type { SnapshotRetentionPolicy, SnapshotService } from "./snapshots.js";
import { DEFAULT_SNAPSHOT_RETENTION } from "./snapshots.js";

/**
 * Interval-based scheduled snapshots for running servers.
 * Disabled when intervalMs <= 0.
 */
export class SnapshotScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(
    private readonly snapshots: SnapshotService,
    private readonly intervalMs = Number(process.env.PLAYON_SNAPSHOT_INTERVAL_MS ?? 0),
    private readonly policy: SnapshotRetentionPolicy = DEFAULT_SNAPSHOT_RETENTION,
  ) {}

  start(): void {
    if (this.intervalMs <= 0 || this.timer) return;
    this.timer = setInterval(() => {
      void this.tick();
    }, this.intervalMs);
    this.timer.unref?.();
    console.log(
      `snapshot scheduler: every ${this.intervalMs}ms (maxCount=${this.policy.maxCount}, maxAgeHours=${this.policy.maxAgeHours})`,
    );
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick(): Promise<{ created: string[]; removed: string[] } | null> {
    if (this.running) return null;
    this.running = true;
    try {
      return await this.snapshots.runScheduledPass(this.policy);
    } finally {
      this.running = false;
    }
  }
}
