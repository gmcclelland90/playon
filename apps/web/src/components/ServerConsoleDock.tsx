import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { api, type ServerDetail } from "../api";
import { useServerLiveLogs } from "../hooks/useServerLiveLogs";

type TranscriptLine = { id: string; kind: "log" | "in" | "out" | "err"; text: string };

type Props = {
  serverId: string;
  serverName: string;
  detail: ServerDetail | undefined;
  onClose: () => void;
};

const DEFAULT_HEIGHT = 240;
const MIN_HEIGHT = 140;
const SIZE_STORAGE_KEY = "playon.consoleDock";

let lineSeq = 0;
function nextId(): string {
  lineSeq += 1;
  return `c${lineSeq}`;
}

function loadDock(): { height: number; collapsed: boolean } {
  try {
    const raw = localStorage.getItem(SIZE_STORAGE_KEY);
    if (!raw) return { height: DEFAULT_HEIGHT, collapsed: false };
    const parsed = JSON.parse(raw) as { height?: unknown; collapsed?: unknown };
    return {
      height: clampHeight(typeof parsed.height === "number" ? parsed.height : DEFAULT_HEIGHT),
      collapsed: parsed.collapsed === true,
    };
  } catch {
    return { height: DEFAULT_HEIGHT, collapsed: false };
  }
}

function clampHeight(n: number): number {
  const max = typeof window !== "undefined" ? Math.floor(window.innerHeight * 0.6) : 600;
  return Math.min(Math.max(max, MIN_HEIGHT), Math.max(MIN_HEIGHT, Math.round(n)));
}

/** Server terminal docked along the bottom of the map, under the LAN room. */
export function ServerConsoleDock({ serverId, serverName, detail, onClose }: Props) {
  const seed = detail?.runtime.logs;
  const consoleCap = detail?.runtime.console;
  const { lines: liveLogs } = useServerLiveLogs(serverId, seed);
  const [extras, setExtras] = useState<TranscriptLine[]>([]);
  const [command, setCommand] = useState("");
  const [busy, setBusy] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [dock, setDock] = useState(loadDock);
  const rootRef = useRef<HTMLElement>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const seededServerRef = useRef<string | undefined>(undefined);
  const dragRef = useRef<{ startY: number; startHeight: number } | null>(null);

  useEffect(() => {
    if (seededServerRef.current !== serverId) {
      seededServerRef.current = serverId;
      setExtras([]);
      setCommand("");
      setSendError(null);
    }
  }, [serverId]);

  useEffect(() => {
    try {
      localStorage.setItem(SIZE_STORAGE_KEY, JSON.stringify(dock));
    } catch {
      /* ignore */
    }
  }, [dock]);

  const transcript: TranscriptLine[] = [
    ...liveLogs.map((text, i) => ({ id: `log-${i}`, kind: "log" as const, text })),
    ...extras,
  ];
  const lastLine = transcript.length ? transcript[transcript.length - 1]!.text : "";

  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [transcript.length, busy, dock.collapsed]);

  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag) return;
      // Anchored to the bottom: dragging the top edge up grows the dock.
      const height = clampHeight(drag.startHeight - (e.clientY - drag.startY));
      setDock((d) => ({ ...d, height }));
    };
    const onUp = () => {
      dragRef.current = null;
      document.body.classList.remove("server-console-resizing");
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
  }, []);

  // Publish the dock's footprint so the LAN room fits above it.
  useEffect(() => {
    const page = rootRef.current?.closest<HTMLElement>(".canvas-page");
    if (!page) return;
    page.style.setProperty("--console-dock-h", dock.collapsed ? "2.6rem" : `${dock.height}px`);
    return () => {
      page.style.removeProperty("--console-dock-h");
    };
  }, [dock.collapsed, dock.height]);

  const inputReady = consoleCap?.input === "ready";
  const inputHint =
    consoleCap?.input === "unsupported"
      ? "Console input is not supported for this server yet."
      : consoleCap?.input === "unavailable"
        ? "Start the server to send commands."
        : null;

  function startResize(e: ReactPointerEvent) {
    if (dock.collapsed) return;
    e.preventDefault();
    dragRef.current = { startY: e.clientY, startHeight: dock.height };
    document.body.classList.add("server-console-resizing");
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
  }

  function onResizeKey(e: ReactKeyboardEvent) {
    if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
    e.preventDefault();
    const step = e.key === "ArrowUp" ? 24 : -24;
    setDock((d) => ({ ...d, height: clampHeight(d.height + step) }));
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    const trimmed = command.trim();
    if (!trimmed || busy || !inputReady) return;
    setBusy(true);
    setSendError(null);
    setExtras((prev) => [...prev, { id: nextId(), kind: "in", text: trimmed }]);
    setCommand("");
    try {
      const result = await api.serverConsole(serverId, trimmed);
      if (result.body) {
        setExtras((prev) => [...prev, { id: nextId(), kind: "out", text: result.body! }]);
      } else if (!result.ok) {
        setExtras((prev) => [
          ...prev,
          {
            id: nextId(),
            kind: "err",
            text: result.error ?? "command_failed",
          },
        ]);
      }
      if (!result.ok && result.error) {
        setSendError(result.hint ?? result.error);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "console_failed";
      setSendError(message);
      setExtras((prev) => [...prev, { id: nextId(), kind: "err", text: message }]);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section
      ref={rootRef}
      className={dock.collapsed ? "server-console-dock is-collapsed" : "server-console-dock"}
      aria-label={`Terminal for ${serverName}`}
    >
      {!dock.collapsed ? (
        <div
          className="server-console-dock-grip"
          role="separator"
          aria-orientation="horizontal"
          aria-label="Resize terminal"
          aria-valuenow={dock.height}
          tabIndex={0}
          onPointerDown={startResize}
          onKeyDown={onResizeKey}
        />
      ) : null}
      <header className="server-console-dock-head">
        <button
          type="button"
          className="server-console-dock-toggle"
          aria-expanded={!dock.collapsed}
          onClick={() => setDock((d) => ({ ...d, collapsed: !d.collapsed }))}
        >
          <span className="server-console-dock-title">Terminal</span>
          <span className="server-console-dock-name">{serverName}</span>
          {dock.collapsed && lastLine ? (
            <span className="server-console-dock-peek">{lastLine}</span>
          ) : null}
        </button>
        {!dock.collapsed && inputHint ? (
          <span className="muted server-console-dock-hint">{inputHint}</span>
        ) : null}
        <button
          type="button"
          className="server-console-dock-icon"
          onClick={() => setDock((d) => ({ ...d, collapsed: !d.collapsed }))}
          aria-label={dock.collapsed ? "Expand terminal" : "Collapse terminal"}
          title={dock.collapsed ? "Expand" : "Collapse"}
        >
          {dock.collapsed ? "\u25B4" : "\u25BE"}
        </button>
        <button
          type="button"
          className="server-console-dock-icon"
          onClick={onClose}
          aria-label="Close terminal"
          title="Close"
        >
          {"\u00D7"}
        </button>
      </header>
      {!dock.collapsed ? (
        <>
          <div className="server-console-dock-log" ref={scrollerRef}>
            {transcript.length === 0 ? (
              <p className="muted server-console-dock-empty">No log output yet.</p>
            ) : (
              transcript.map((line, i) => (
                <div
                  key={`${line.id}-${i}`}
                  className={`server-console-line server-console-line-${line.kind}`}
                >
                  {line.kind === "in" ? `\u203A ${line.text}` : line.text}
                </div>
              ))
            )}
          </div>
          {inputReady || sendError ? (
            <form className="server-console-dock-form" onSubmit={onSubmit}>
              <input
                type="text"
                value={command}
                onChange={(e) => setCommand(e.target.value)}
                placeholder="Enter command…"
                disabled={!inputReady || busy}
                autoComplete="off"
                spellCheck={false}
                aria-label="Console command"
              />
              <button
                type="submit"
                className="btn btn-primary"
                disabled={!inputReady || busy || !command.trim()}
              >
                Send
              </button>
              {sendError ? <p className="error server-console-dock-error">{sendError}</p> : null}
            </form>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
