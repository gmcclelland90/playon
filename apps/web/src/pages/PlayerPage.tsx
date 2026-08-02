import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type PanelBlockRow } from "../api";
import { groupPanelByServer, joinEndpoint } from "../panel-view";
import { panelSocket } from "../panel-ws";
import { statusLabel } from "../status";

function connectCommandFromBody(body: Record<string, unknown>): string | null {
  const cmd = typeof body.connectCommand === "string" ? body.connectCommand.trim() : "";
  return cmd || null;
}

/** Agent/control-plane steam:// link only — reject other schemes in the UI. */
function steamConnectUrlFromBody(body: Record<string, unknown>): string | null {
  const raw = typeof body.steamConnectUrl === "string" ? body.steamConnectUrl.trim() : "";
  if (!raw || !/^steam:\/\//i.test(raw) || /[\s<>"']/.test(raw)) return null;
  return raw;
}

/** Works on plain HTTP LAN hosts where navigator.clipboard is blocked. */
async function copyText(text: string): Promise<boolean> {
  try {
    if (typeof navigator !== "undefined" && navigator.clipboard?.writeText && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through to execCommand */
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.top = "0";
    ta.style.left = "-9999px";
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
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

/** Short copy under the join hero — game-aware (not Minecraft-only). */
function joinHeroHint(game?: string | null): string {
  const g = (game ?? "").trim().toLowerCase();
  if (g.includes("rust")) {
    return "Prefer Open in Steam, or Steam → F1 → paste the connect command";
  }
  if (g.includes("unreal") || g === "ut99" || g.includes("tournament")) {
    return "Unreal Tournament 99 · Multiplayer → Open → paste address";
  }
  if (g.includes("minecraft") || g === "paper") {
    return "Minecraft Java · Multiplayer → Direct Connection → paste address";
  }
  if (!g) return "Copy the address above and paste it in your game client";
  return `${game} · connect with the address above`;
}

function sectionTitle(join: PanelBlockRow | undefined, themeGame?: string): string {
  if (join?.title?.trim()) return join.title.trim();
  const game =
    (typeof join?.body.game === "string" && join.body.game) || themeGame || undefined;
  if (game) return game;
  return "Live server";
}

export function PlayerPage() {
  const qc = useQueryClient();
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [copyError, setCopyError] = useState(false);
  const [readyAck, setReadyAck] = useState(false);
  const [voteChoiceByBlock, setVoteChoiceByBlock] = useState<Record<string, string>>({});
  const [voteAckByBlock, setVoteAckByBlock] = useState<Record<string, string>>({});
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
    mutationFn: ({ blockId, choice }: { blockId: string; choice: string }) =>
      api.panelInput({ type: "vote", payload: { choice, blockId } }),
    onSuccess: async (_data, vars) => {
      setVoteAckByBlock((prev) => ({ ...prev, [vars.blockId]: vars.choice }));
      await qc.invalidateQueries({ queryKey: ["panel"] });
    },
  });

  const blocks = panel.data?.blocks ?? [];
  const theme = panel.data?.theme ?? { id: "default" };
  const groups = useMemo(() => groupPanelByServer(blocks), [blocks]);
  const liveGroups = useMemo(
    () => groups.filter((g) => g.join && joinEndpoint(g.join.body)),
    [groups],
  );
  const generalRest = useMemo(() => {
    const general = groups.find((g) => g.serverId === null && !g.join);
    return general?.rest ?? [];
  }, [groups]);
  const hasLive = liveGroups.length > 0;

  async function copyValue(key: string, value: string) {
    const ok = await copyText(value);
    if (!ok) {
      setCopyError(true);
      setCopiedKey(null);
      window.setTimeout(() => setCopyError(false), 2200);
      return;
    }
    setCopyError(false);
    setCopiedKey(key);
    window.setTimeout(() => setCopiedKey(null), 1600);
  }

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
          {liveGroups.length > 1
            ? `${liveGroups.length} live servers — join info updated by the host.`
            : "Tonight’s join info — updated live by the host."}
          {theme.game && liveGroups.length <= 1 ? ` · ${theme.game}` : ""}
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

      {!panel.isLoading && !panel.isError && !hasLive ? (
        <div className="block">
          <span className="chip">Waiting</span>
          <h2>No live servers yet</h2>
          <p className="muted status-inline">
            When the host starts a game, the join address shows up here.
          </p>
        </div>
      ) : null}

      {liveGroups.map((group, index) => {
        const joinBlock = group.join!;
        const join = joinEndpoint(joinBlock.body)!;
        const connectCommand = connectCommandFromBody(joinBlock.body);
        const steamConnectUrl = steamConnectUrlFromBody(joinBlock.body);
        const status =
          typeof group.status?.body.status === "string"
            ? group.status.body.status
            : undefined;
        const joinGame =
          (typeof joinBlock.body.game === "string" && joinBlock.body.game) ||
          theme.game ||
          undefined;
        const addrKey = `${group.key}:address`;
        const cmdKey = `${group.key}:command`;

        return (
          <section
            key={group.key}
            className={index === 0 ? "server-section server-section-primary" : "server-section"}
            aria-label={sectionTitle(joinBlock, theme.game)}
          >
            <header className="server-section-header">
              <span className="chip">Join</span>
              <h2 className="server-section-title">{sectionTitle(joinBlock, theme.game)}</h2>
              {status ? (
                <p
                  className={`status status-inline ${status === "running" ? "" : "stopped"}`}
                >
                  {statusLabel(status)}
                </p>
              ) : (
                <p className="status status-inline">Live</p>
              )}
            </header>

            <p className="join-label muted">Address</p>
            <p className="join-endpoint">{join}</p>
            <div className="btn-row">
              {steamConnectUrl ? (
                <a className="btn btn-primary" href={steamConnectUrl}>
                  Open in Steam
                </a>
              ) : null}
              <button
                className={steamConnectUrl ? "btn btn-ghost" : "btn btn-primary"}
                type="button"
                onClick={() => void copyValue(addrKey, join)}
                aria-live="polite"
              >
                {copiedKey === addrKey ? "Copied" : "Copy address"}
              </button>
            </div>
            {connectCommand ? (
              <div className="join-command">
                <p className="join-label muted">Connect command</p>
                <p className="join-command-text">{connectCommand}</p>
                <div className="btn-row">
                  <button
                    className="btn btn-ghost"
                    type="button"
                    onClick={() => void copyValue(cmdKey, connectCommand)}
                    aria-live="polite"
                  >
                    {copiedKey === cmdKey ? "Copied" : "Copy command"}
                  </button>
                </div>
              </div>
            ) : null}
            {copyError ? (
              <p className="error status-inline" role="alert">
                Couldn’t copy — select the text and copy manually.
              </p>
            ) : null}
            <p className="muted status-inline">{joinHeroHint(joinGame)}</p>

            {group.rest.map((block) => (
              <PanelBlockCard
                key={block.id}
                block={block}
                voteChoice={voteChoiceByBlock[block.id] ?? ""}
                voteAcked={voteAckByBlock[block.id]}
                onVoteChoice={(value) =>
                  setVoteChoiceByBlock((prev) => ({ ...prev, [block.id]: value }))
                }
                onVote={() => {
                  const choice = voteChoiceByBlock[block.id];
                  if (choice) vote.mutate({ blockId: block.id, choice });
                }}
                votePending={vote.isPending}
              />
            ))}
          </section>
        );
      })}

      {generalRest.map((block) => (
        <PanelBlockCard
          key={block.id}
          block={block}
          voteChoice={voteChoiceByBlock[block.id] ?? ""}
          voteAcked={voteAckByBlock[block.id]}
          onVoteChoice={(value) =>
            setVoteChoiceByBlock((prev) => ({ ...prev, [block.id]: value }))
          }
          onVote={() => {
            const choice = voteChoiceByBlock[block.id];
            if (choice) vote.mutate({ blockId: block.id, choice });
          }}
          votePending={vote.isPending}
        />
      ))}

      {hasLive ? (
        <>
          <div className="btn-row">
            <button
              className="btn btn-ghost"
              type="button"
              onClick={() => ready.mutate()}
              disabled={ready.isPending}
              aria-busy={ready.isPending}
            >
              {ready.isPending ? "Sending…" : readyAck ? "Ready ✓" : "I'm ready"}
            </button>
          </div>
          {readyAck ? (
            <p className="muted status-inline" aria-live="polite">
              Host notified you&apos;re ready.
            </p>
          ) : null}
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
        </>
      ) : null}
    </div>
  );
}

function bodySteps(body: Record<string, unknown>): string[] {
  if (!Array.isArray(body.steps)) return [];
  return body.steps.map(String).map((s) => s.trim()).filter(Boolean);
}

function PanelBlockCard({
  block,
  voteChoice,
  voteAcked,
  onVoteChoice,
  onVote,
  votePending,
}: {
  block: PanelBlockRow;
  voteChoice: string;
  voteAcked?: string;
  onVoteChoice: (value: string) => void;
  onVote: () => void;
  votePending: boolean;
}) {
  const options = Array.isArray(block.body.options)
    ? block.body.options.map(String)
    : Array.isArray(block.body.choices)
      ? block.body.choices.map(String)
      : [];
  const steps = bodySteps(block.body);

  return (
    <article className="block">
      <span className="chip">{chipLabel(block.type)}</span>
      <h2>{block.title}</h2>
      {typeof block.body.summary === "string" ? <p>{block.body.summary}</p> : null}
      {typeof block.body.notes === "string" ? <p>{block.body.notes}</p> : null}
      {typeof block.body.instructions === "string" ? (
        <p className="muted">{block.body.instructions}</p>
      ) : null}
      {steps.length ? (
        <ol className="panel-steps">
          {steps.map((step, i) => (
            <li key={`${block.id}-step-${i}`}>{step}</li>
          ))}
        </ol>
      ) : null}
      {typeof block.body.url === "string" ? (
        <p>
          <a href={block.body.url}>{block.body.url}</a>
        </p>
      ) : null}
      {block.type === "vote" && options.length ? (
        voteAcked ? (
          <p className="ok status-inline" aria-live="polite">
            Voted · {voteAcked}
          </p>
        ) : (
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
        )
      ) : null}
    </article>
  );
}
