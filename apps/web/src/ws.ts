import { WsEventSchema, type WsEvent } from "@playon/shared";

export type WsStatus = "connecting" | "open" | "closed";

type Listener = (event: WsEvent) => void;

function wsUrl(): string {
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${window.location.host}/api/ws`;
}

/** Singleton admin WebSocket with reconnect. */
class PlayOnSocket {
  private socket: WebSocket | null = null;
  private listeners = new Set<Listener>();
  private statusListeners = new Set<(status: WsStatus) => void>();
  private status: WsStatus = "closed";
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private shouldRun = false;
  /** Bumps on each intentional disconnect so stale onclose handlers cannot reconnect. */
  private generation = 0;

  connect(): void {
    this.shouldRun = true;
    if (
      this.socket &&
      (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING)
    ) {
      return;
    }
    this.setStatus("connecting");
    const generation = this.generation;
    const socket = new WebSocket(wsUrl());
    this.socket = socket;

    socket.onopen = () => {
      if (this.socket !== socket || this.generation !== generation) {
        socket.close();
        return;
      }
      this.setStatus("open");
    };
    socket.onmessage = (msg) => {
      if (this.socket !== socket || this.generation !== generation) return;
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
      // Ignore close from a superseded socket (Strict Mode remount / rapid reconnect races).
      if (this.socket !== socket && this.generation === generation) {
        // socket was replaced; nothing to do
        return;
      }
      if (this.generation !== generation) return;
      this.setStatus("closed");
      if (this.socket === socket) this.socket = null;
      if (this.shouldRun) {
        this.reconnectTimer = setTimeout(() => this.connect(), 1500);
      }
    };
    socket.onerror = () => {
      if (this.socket === socket) socket.close();
    };
  }

  disconnect(): void {
    this.shouldRun = false;
    this.generation += 1;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const socket = this.socket;
    this.socket = null;
    socket?.close();
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

  onStatus(listener: (status: WsStatus) => void): () => void {
    this.statusListeners.add(listener);
    listener(this.status);
    return () => this.statusListeners.delete(listener);
  }

  private setStatus(status: WsStatus): void {
    this.status = status;
    for (const listener of this.statusListeners) listener(status);
  }
}

export const playonSocket = new PlayOnSocket();
