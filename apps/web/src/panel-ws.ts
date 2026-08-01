import { WsEventSchema, type WsEvent } from "@playon/shared";

export type PanelWsStatus = "connecting" | "open" | "closed";

type Listener = (event: WsEvent) => void;

function panelWsUrl(): string {
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${window.location.host}/api/panel/ws`;
}

/** Public player panel socket — reconnects with backoff; panel.updated only. */
class PanelSocket {
  private socket: WebSocket | null = null;
  private listeners = new Set<Listener>();
  private statusListeners = new Set<(status: PanelWsStatus) => void>();
  private status: PanelWsStatus = "closed";
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private shouldRun = false;
  private attempt = 0;

  get connected(): boolean {
    return this.status === "open";
  }

  connect(): void {
    this.shouldRun = true;
    if (
      this.socket &&
      (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING)
    ) {
      return;
    }
    this.setStatus("connecting");
    const socket = new WebSocket(panelWsUrl());
    this.socket = socket;

    socket.onopen = () => {
      this.attempt = 0;
      this.setStatus("open");
    };
    socket.onmessage = (msg) => {
      if (typeof msg.data !== "string") return;
      try {
        const parsed = WsEventSchema.safeParse(JSON.parse(msg.data));
        if (!parsed.success) return;
        for (const listener of this.listeners) listener(parsed.data);
      } catch {
        // ignore
      }
    };
    socket.onclose = () => {
      this.setStatus("closed");
      this.socket = null;
      if (this.shouldRun) {
        const delay = Math.min(15_000, 1000 * 2 ** Math.min(this.attempt, 4));
        this.attempt += 1;
        this.reconnectTimer = setTimeout(() => this.connect(), delay);
      }
    };
    socket.onerror = () => {
      socket.close();
    };
  }

  disconnect(): void {
    this.shouldRun = false;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.socket?.close();
    this.socket = null;
    this.setStatus("closed");
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    this.connect();
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0) this.disconnect();
    };
  }

  onStatus(listener: (status: PanelWsStatus) => void): () => void {
    this.statusListeners.add(listener);
    listener(this.status);
    return () => this.statusListeners.delete(listener);
  }

  private setStatus(status: PanelWsStatus): void {
    this.status = status;
    for (const listener of this.statusListeners) listener(status);
  }
}

export const panelSocket = new PanelSocket();
