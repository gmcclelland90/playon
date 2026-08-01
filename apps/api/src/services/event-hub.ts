import type { WsEvent } from "@playon/shared";

export type EventHubListener = (event: WsEvent) => void;

/** In-process fan-out for validated WebSocket events. */
export class EventHub {
  private readonly listeners = new Set<EventHubListener>();

  subscribe(listener: EventHubListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  publish(event: WsEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // one bad client must not break others
      }
    }
  }

  get size(): number {
    return this.listeners.size;
  }
}
