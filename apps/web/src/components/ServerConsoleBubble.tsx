import { useEffect, useRef, useState, type FormEvent, type PointerEvent as ReactPointerEvent } from "react";
import { api, type ServerDetail } from "../api";
import { useServerLiveLogs } from "../hooks/useServerLiveLogs";
import type { SelectedAnchor } from "./agent-canvas/AgentCanvas";

type TranscriptLine = { id: string; kind: "log" | "in" | "out" | "err"; text: string };

type Props = {
  serverId: string;
  serverName: string;
  anchor: SelectedAnchor | null;
  detail: ServerDetail | undefined;
};

type ResizeDir = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";

const DEFAULT_WIDTH = 640;
const DEFAULT_LOG_HEIGHT = 256;
const MIN_WIDTH = 320;
const MIN_LOG_HEIGHT = 120;
const SIZE_STORAGE_KEY = "playon.consoleBubbleSize";

let lineSeq = 0;
function nextId(): string {
  lineSeq += 1;
  return `c${lineSeq}`;
}

function loadSize(): { width: number; logHeight: number } {
  try {
    const raw = localStorage.getItem(SIZE_STORAGE_KEY);
    if (!raw) return { width: DEFAULT_WIDTH, logHeight: DEFAULT_LOG_HEIGHT };
    const parsed = JSON.parse(raw) as { width?: unknown; logHeight?: unknown };
    const width = typeof parsed.width === "number" ? parsed.width : DEFAULT_WIDTH;
    const logHeight = typeof parsed.logHeight === "number" ? parsed.logHeight : DEFAULT_LOG_HEIGHT;
    return {
      width: clampWidth(width),
      logHeight: clampLogHeight(logHeight),
    };
  } catch {
    return { width: DEFAULT_WIDTH, logHeight: DEFAULT_LOG_HEIGHT };
  }
}

function clampWidth(n: number): number {
  const max = Math.min(1200, typeof window !== "undefined" ? window.innerWidth - 32 : 1200);
  return Math.min(max, Math.max(MIN_WIDTH, Math.round(n)));
}

function clampLogHeight(n: number): number {
  const max = Math.min(800, typeof window !== "undefined" ? Math.floor(window.innerHeight * 0.7) : 800);
  return Math.min(max, Math.max(MIN_LOG_HEIGHT, Math.round(n)));
}

const RESIZE_DIRS: ResizeDir[] = ["n", "s", "e", "w", "ne", "nw", "se", "sw"];

export function ServerConsoleBubble({ serverId, serverName, anchor, detail }: Props) {
  const seed = detail?.runtime.logs;
  const consoleCap = detail?.runtime.console;
  const { lines: liveLogs } = useServerLiveLogs(serverId, seed);
  const [extras, setExtras] = useState<TranscriptLine[]>([]);
  const [command, setCommand] = useState("");
  const [busy, setBusy] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [size, setSize] = useState(loadSize);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const seededServerRef = useRef<string | undefined>(undefined);
  const dragRef = useRef<{
    dir: ResizeDir;
    startX: number;
    startY: number;
    startWidth: number;
    startLogHeight: number;
  } | null>(null);

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
      localStorage.setItem(SIZE_STORAGE_KEY, JSON.stringify(size));
    } catch {
      /* ignore */
    }
  }, [size]);

  const transcript: TranscriptLine[] = [
    ...liveLogs.map((text, i) => ({ id: `log-${i}`, kind: "log" as const, text })),
    ...extras,
  ];

  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [transcript.length, busy]);

  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag) return;
      const dx = e.clientX - drag.startX;
      const dy = e.clientY - drag.startY;
      let width = drag.startWidth;
      let logHeight = drag.startLogHeight;

      // Bubble is centered horizontally; east grows width, west grows when dragging left.
      if (drag.dir.includes("e")) width = drag.startWidth + dx;
      if (drag.dir.includes("w")) width = drag.startWidth - dx;
      // Anchored from the bottom; north (up) grows height, south grows when dragging down.
      if (drag.dir.includes("n")) logHeight = drag.startLogHeight - dy;
      if (drag.dir.includes("s")) logHeight = drag.startLogHeight + dy;

      setSize({
        width: clampWidth(width),
        logHeight: clampLogHeight(logHeight),
      });
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

  const inputReady = consoleCap?.input === "ready";
  const inputHint =
    consoleCap?.input === "unsupported"
      ? "Console input is not supported for this server yet."
      : consoleCap?.input === "unavailable"
        ? "Console input unavailable (start the server first)."
        : null;

  function startResize(dir: ResizeDir, e: ReactPointerEvent) {
    e.preventDefault();
    e.stopPropagation();
    dragRef.current = {
      dir,
      startX: e.clientX,
      startY: e.clientY,
      startWidth: size.width,
      startLogHeight: size.logHeight,
    };
    document.body.classList.add("server-console-resizing");
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
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

  if (!anchor) return null;

  return (
    <div
      className="server-console-bubble"
      style={{
        left: anchor.x,
        top: anchor.y,
        width: size.width,
      }}
      role="dialog"
      aria-label={`Terminal for ${serverName}`}
    >
      <div className="server-console-bubble-panel">
        <div className="server-console-bubble-head">
          <span className="server-console-bubble-title">Terminal</span>
          <span className="muted server-console-bubble-name">{serverName}</span>
        </div>
        <div
          className="server-console-bubble-log"
          ref={scrollerRef}
          style={{ height: size.logHeight }}
        >
          {transcript.length === 0 ? (
            <p className="muted server-console-bubble-empty">No log output yet.</p>
          ) : (
            transcript.map((line, i) => (
              <div
                key={`${line.id}-${i}`}
                className={`server-console-line server-console-line-${line.kind}`}
              >
                {line.kind === "in" ? `› ${line.text}` : line.text}
              </div>
            ))
          )}
        </div>
        <form className="server-console-bubble-form" onSubmit={onSubmit}>
          <input
            type="text"
            value={command}
            onChange={(e) => setCommand(e.target.value)}
            placeholder={inputReady ? "Enter command…" : "Input disabled"}
            disabled={!inputReady || busy}
            autoComplete="off"
            spellCheck={false}
            aria-label="Console command"
          />
          <button type="submit" className="btn btn-primary" disabled={!inputReady || busy || !command.trim()}>
            Send
          </button>
        </form>
        {inputHint ? <p className="muted server-console-bubble-hint">{inputHint}</p> : null}
        {sendError ? <p className="error server-console-bubble-hint">{sendError}</p> : null}

        {RESIZE_DIRS.map((dir) => (
          <div
            key={dir}
            className={`server-console-resize server-console-resize-${dir}`}
            onPointerDown={(e) => startResize(dir, e)}
            role="separator"
            aria-label={`Resize ${dir}`}
          />
        ))}
        <div
          className="server-console-resize-grip"
          onPointerDown={(e) => startResize("se", e)}
          title="Drag to resize"
          aria-hidden
        />
      </div>
      <div className="server-console-bubble-tail" aria-hidden />
    </div>
  );
}
