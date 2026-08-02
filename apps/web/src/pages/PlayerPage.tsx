import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type PanelBlockRow } from "../api";
import { panelSocket } from "../panel-ws";
import { statusLabel } from "../status";

function joinEndpoint(body: Record<string, unknown>): string | null {
  if (typeof body.endpoint === "string" && body.endpoint.trim()) return body.endpoint.trim();
  const address = typeof body.address === "string" ? body.address : "";
  const port = typeof body.port === "number" ? body.port : Number(body.port);
  if (address && Number.isFinite(port)) return `${address}:${port}`;
  if (address) return address;
  return null;
}

function chipLabel(type: string): string {
  switch (type) {
    case "join_info":
      return "Join";
    case "server_status":
      return "Status";
    case "client_setup":
      return "Setup";
    case "announcement":
      return "Note";
    case "vote":
      return "Vote";
    case "readiness":
      return "Ready";
    case "guide":
      return "Guide";
    default:
      return "Update";
  }
}

export function PlayerPage() {
  const qc = useQueryClient();
  const [copied, setCopied] = useState(false);
  const [readyAck, setReadyAck] = useState(false);
  const [voteChoice, setVoteChoice] = useState<string>("");
  const [wsOpen, setWsOpen] = useState(false);
  const [visible, setVisible] = useState(
    () => typeof document === "undefined" || document.visibilityState === "visible",
  );
  const etagRef = useRef<string | undefined>(undefined);
  const lastPayloadRef = useRef<{
    blocks: PanelBlockRow[];
    theme: { id: string; primaryHue?: number; game?: string; skillName?: string };
  } | null>(null);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    const onVis = () => setVisible(document.visibilityState === "visible");
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, []);

  useEffect(() => {
    const offStatus = panelSocket.onStatus((s) => setWsOpen(s === "open"));
    const offEvent = panelSocket.subscribe((event) => {
      if (event.type === "panel.updated") {
        void qc.invalidateQueries({ queryKey: ["panel"] });
      }
    });
    return () => {
      offStatus();
      offEvent();
    };
  }, [qc]);

  const panel = useQuery({
    queryKey: ["panel"],
    queryFn: async () => {
      const result = await api.panel(undefined, etagRef.current);
      if (result.notModified && lastPayloadRef.current) {
        return lastPayloadRef.current;
      }
      if (!result.notModified) {
        etagRef.current = result.etag ?? undefined;
        lastPayloadRef.current = { blocks: result.blocks, theme: result.theme };
        return lastPayloadRef.current;
      }
      return lastPayloadRef.current ?? { blocks: [], theme: { id: "default" } };
    },
    refetchInterval: () => {
      if (!visible) return false;
      return wsOpen ? 30_000 : 12_000;
    },
    refetchOnWindowFocus: true,
  });

  useEffect(() => {
    if (panel.data && !hydrated) setHydrated(true);
  }, [panel.data, hydrated]);

  const ready = useMutation({
    mutationFn: () => api.panelInput({ type: "readiness", payload: { ready: true } }),
    onSuccess: async () => {
      setReadyAck(true);
      await qc.invalidateQueries({ queryKey: ["panel"] });
    },
  });

  const vote = useMutation({
    mutationFn: (choice: string) =>
      api.panelInput({ type: "vote", payload: { choice } }),
    onSuccess: async () => {
      setVoteChoice("");
      await qc.invalidateQueries({ queryKey: ["panel"] });
    },
  });

  const blocks = panel.data?.blocks ?? [];
  const theme = panel.data?.theme ?? { id: "default" };
  const joinBlock = useMemo(
    () => blocks.find((b) => b.type === "join_info"),
    [blocks],
  );
  const join = joinBlock ? joinEndpoint(joinBlock.body) : null;
  const statusBlock = blocks.find((b) => b.type === "server_status");
  const status =
    typeof statusBlock?.body.status === "string" ? statusBlock.body.status : undefined;

  async function copyJoin() {
    if (!join) return;
    try {
      await navigator.clipboard.writeText(join);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      /* clipboard may be unavailable */
    }
  }

  const restBlocks = blocks.filter((b) => b.type !== "join_info");
  const themeStyle =
    typeof theme.primaryHue === "number"
      ? ({
          "--primary": `oklch(0.62 0.14 ${theme.primaryHue})`,
          "--surface": `oklch(0.16 0.014 ${theme.primaryHue})`,
          "--surface-2": `oklch(0.2 0.016 ${theme.primaryHue})`,
          "--wash-a": `oklch(0.62 0.14 ${theme.primaryHue} / 0.18)`,
        } as CSSProperties)
      : undefined;

  return (
    <div
      className={`player${hydrated ? " panel-live" : ""}`}
      data-theme={theme.id}
      style={themeStyle}
      aria-busy={panel.isFetching && !panel.data ? true : undefined}
    >
      <header className="player-header">
        <h1 className="brand-mark">
          Play<span>On</span>
        </h1>
        <p className="muted player-lede">
          Tonight’s join info — updated live by the host.
          {theme.game ? ` · ${theme.game}` : ""}
        </p>
      </header>

      {panel.isLoading ? (
        <div className="skeleton" aria-busy="true" aria-label="Loading panel">
          <div className="skeleton-row" />
          <div className="skeleton-row compact" />
        </div>
      ) : null}

      {panel.isError ? (
        <p className="error" role="alert">
          {(panel.error as Error).message || "Could not load the player panel."}
        </p>
      ) : null}

      {!panel.isLoading && !panel.isError && blocks.length === 0 ? (
        <div className="block">
          <span className="chip">Waiting</span>
          <h2>No servers posted yet</h2>
          <p className="muted status-inline">
            When the host spins something up, connection details and setup steps appear here.
          </p>
        </div>
      ) : null}

      {join ? (
        <section className="join-hero" aria-label="Join address">
          <span className="chip">Join</span>
          <p className="join-endpoint">{join}</p>
          {status ? (
            <p
              className={`status status-inline ${status === "running" ? "" : "stopped"}`}
            >
              {statusLabel(status)}
            </p>
          ) : null}
          <div className="btn-row">
            <button
              className="btn btn-primary"
              type="button"
              onClick={() => void copyJoin()}
              aria-live="polite"
            >
              {copied ? "Copied" : "Copy address"}
            </button>
          </div>
          {typeof joinBlock?.body.runtime === "string" ? (
            <p className="muted status-inline">Runtime: {String(joinBlock.body.runtime)}</p>
          ) : null}
        </section>
      ) : null}

      {restBlocks.map((block) => (
        <PanelBlockCard
          key={block.id}
          block={block}
          voteChoice={voteChoice}
          onVoteChoice={setVoteChoice}
          onVote={() => {
            if (voteChoice) vote.mutate(voteChoice);
          }}
          votePending={vote.isPending}
        />
      ))}

      <div className="btn-row">
        <button
          className="btn btn-primary"
          type="button"
          onClick={() => ready.mutate()}
          disabled={ready.isPending}
          aria-busy={ready.isPending}
        >
          {ready.isPending ? "Sending…" : readyAck ? "Ready ✓" : "I'm ready"}
        </button>
      </div>
      {ready.isError ? (
        <p className="error" role="alert">
          {(ready.error as Error).message}
        </p>
      ) : null}
      {vote.isError ? (
        <p className="error" role="alert">
          {(vote.error as Error).message}
        </p>
      ) : null}
      <p className="muted status-inline">
        Tells the host you’re set. Hosts manage servers from the{" "}
        <Link to="/login">admin login</Link>.
      </p>
    </div>
  );
}

function PanelBlockCard({
  block,
  voteChoice,
  onVoteChoice,
  onVote,
  votePending,
}: {
  block: PanelBlockRow;
  voteChoice: string;
  onVoteChoice: (value: string) => void;
  onVote: () => void;
  votePending: boolean;
}) {
  const options = Array.isArray(block.body.options)
    ? block.body.options.map(String)
    : Array.isArray(block.body.choices)
      ? block.body.choices.map(String)
      : [];

  return (
    <article className="block">
      <span className="chip">{chipLabel(block.type)}</span>
      <h2>{block.title}</h2>
      {typeof block.body.summary === "string" ? <p>{block.body.summary}</p> : null}
      {typeof block.body.notes === "string" ? <p>{block.body.notes}</p> : null}
      {typeof block.body.instructions === "string" ? (
        <p className="muted">{block.body.instructions}</p>
      ) : null}
      {typeof block.body.url === "string" ? (
        <p>
          <a href={block.body.url}>{block.body.url}</a>
        </p>
      ) : null}
      {typeof block.body.status === "string" && block.type === "server_status" ? (
        <p className={`status ${block.body.status === "running" ? "" : "stopped"}`}>
          {statusLabel(String(block.body.status))}
        </p>
      ) : null}
      {block.type === "vote" && options.length ? (
        <div className="stack vote-stack">
          <label className="field">
            <span>Your vote</span>
            <select
              value={voteChoice}
              onChange={(e) => onVoteChoice(e.target.value)}
              disabled={votePending}
            >
              <option value="">Pick one…</option>
              {options.map((opt) => (
                <option key={opt} value={opt}>
                  {opt}
                </option>
              ))}
            </select>
          </label>
          <button
            className="btn btn-ghost"
            type="button"
            disabled={!voteChoice || votePending}
            onClick={onVote}
          >
            {votePending ? "Sending…" : "Submit vote"}
          </button>
        </div>
      ) : null}
    </article>
  );
}
