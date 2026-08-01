import { nanoid } from "nanoid";
import type { ConfirmGate } from "@playon/agent-core";
import type { EventHub } from "./event-hub.js";

type Pending = {
  resolve: (approved: boolean) => void;
  timer: ReturnType<typeof setTimeout>;
};

/** In-process host.confirm waiter + EventHub publisher. */
export class ConfirmService implements ConfirmGate {
  private readonly pending = new Map<string, Pending>();

  constructor(
    private readonly events: EventHub,
    private readonly timeoutMs = Number(process.env.PLAYON_CONFIRM_TIMEOUT_MS ?? 120_000),
  ) {}

  async requestConfirmation(request: {
    toolName: string;
    summary: string;
    arguments: Record<string, unknown>;
  }): Promise<{ requestId: string; approved: boolean }> {
    const requestId = nanoid();
    this.events.publish({
      type: "confirm.required",
      requestId,
      summary: request.summary,
    });

    const approved = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        resolve(false);
      }, this.timeoutMs);
      timer.unref?.();
      this.pending.set(requestId, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        timer,
      });
    });

    return { requestId, approved };
  }

  resolve(requestId: string, approved: boolean): boolean {
    const entry = this.pending.get(requestId);
    if (!entry) return false;
    this.pending.delete(requestId);
    clearTimeout(entry.timer);
    entry.resolve(approved);
    return true;
  }

  get size(): number {
    return this.pending.size;
  }
}
