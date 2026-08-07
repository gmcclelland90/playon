import { useEffect, useRef, useState, type FormEvent } from "react";
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

let lineSeq = 0;
function nextId(): string {
  lineSeq += 1;
  return `c${lineSeq}`;
}

export function ServerConsoleBubble({ serverId, serverName, anchor, detail }: Props) {
  const seed = detail?.runtime.logs;
  const consoleCap = detail?.runtime.console;
  const { lines: liveLogs } = useServerLiveLogs(serverId, seed);
  const [extras, setExtras] = useState<TranscriptLine[]>([]);
  const [command, setCommand] = useState("");
  const [busy, setBusy] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const seededServerRef = useRef<string | undefined>(undefined);

  useEffect(() => {
    if (seededServerRef.current !== serverId) {
      seededServerRef.current = serverId;
      setExtras([]);
      setCommand("");
      setSendError(null);
    }
  }, [serverId]);

  const transcript: TranscriptLine[] = [
    ...liveLogs.map((text, i) => ({ id: `log-${i}`, kind: "log" as const, text })),
    ...extras,
  ];

  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [transcript.length, busy]);

  const inputReady = consoleCap?.input === "ready";
  const inputHint =
    consoleCap?.input === "unsupported"
      ? "Console input is not supported for this server yet."
      : consoleCap?.input === "unavailable"
        ? "Console input unavailable (start the server first)."
        : null;

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
      }}
      role="dialog"
      aria-label={`Terminal for ${serverName}`}
    >
      <div className="server-console-bubble-panel">
        <div className="server-console-bubble-head">
          <span className="server-console-bubble-title">Terminal</span>
          <span className="muted server-console-bubble-name">{serverName}</span>
        </div>
        <div className="server-console-bubble-log" ref={scrollerRef}>
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
      </div>
      <div className="server-console-bubble-tail" aria-hidden />
    </div>
  );
}
