import { useEffect, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { PublicUser } from "@playon/shared";
import { api, type ToolTrace } from "../api";
import { playonSocket } from "../ws";

type ChatLine = {
  role: "user" | "assistant";
  content: string;
  tools?: ToolTrace[];
  llmMode?: string;
};

const CHAT_KEY = "playon.chat.v1";

function loadChat(): { conversationId?: string; lines: ChatLine[] } {
  try {
    const raw = sessionStorage.getItem(CHAT_KEY);
    if (!raw) return { lines: [] };
    return JSON.parse(raw) as { conversationId?: string; lines: ChatLine[] };
  } catch {
    return { lines: [] };
  }
}

export function ChatPage({ user }: { user: PublicUser }) {
  const qc = useQueryClient();
  const saved = loadChat();
  const [message, setMessage] = useState("");
  const [conversationId, setConversationId] = useState<string | undefined>(saved.conversationId);
  const [lines, setLines] = useState<ChatLine[]>(saved.lines);
  const [hydrated, setHydrated] = useState(!saved.conversationId);
  const [pendingConfirm, setPendingConfirm] = useState<{ requestId: string; summary: string } | null>(
    null,
  );
  const [confirmBusy, setConfirmBusy] = useState(false);
  const [liveConversationId, setLiveConversationId] = useState<string | undefined>();
  const [celebration, setCelebration] = useState<string | null>(null);

  useEffect(() => {
    sessionStorage.setItem(CHAT_KEY, JSON.stringify({ conversationId, lines }));
  }, [conversationId, lines]);

  useEffect(() => {
    return playonSocket.subscribe((event) => {
      if (event.type === "agent.celebration") {
        const msg = event.leveledUp
          ? `${event.title} hit level ${event.level} (+${event.xpGained} XP)`
          : `${event.title} earned +${event.xpGained} XP (${event.reason.replace(/_/g, " ")})`;
        setCelebration(msg);
        window.setTimeout(() => setCelebration(null), 5000);
        void qc.invalidateQueries({ queryKey: ["agent-progress"] });
        return;
      }
      if (event.type === "host.achievement") {
        setCelebration(`Achievement: ${event.title}`);
        window.setTimeout(() => setCelebration(null), 5000);
        void qc.invalidateQueries({ queryKey: ["achievements"] });
        return;
      }
      if (event.type === "confirm.required") {
        setPendingConfirm({ requestId: event.requestId, summary: event.summary });
        return;
      }
      if (event.type === "chat.token") {
        if (liveConversationId && event.conversationId !== liveConversationId) return;
        setLines((prev) => {
          const next = [...prev];
          const last = next[next.length - 1];
          if (!last || last.role !== "assistant") return prev;
          next[next.length - 1] = { ...last, content: `${last.content}${event.token}` };
          return next;
        });
        return;
      }
      if (event.type === "chat.tool") {
        if (liveConversationId && event.conversationId !== liveConversationId) return;
        setLines((prev) => {
          const next = [...prev];
          const last = next[next.length - 1];
          if (!last || last.role !== "assistant") return prev;
          const tools = [...(last.tools ?? [])];
          const existing = tools.findIndex((t) => t.name === event.toolName && !t.result);
          const entry: ToolTrace = {
            name: event.toolName,
            arguments: (event.detail?.arguments as Record<string, unknown>) ?? {},
            result: event.status === "started" ? undefined : (event.detail ?? { status: event.status }),
          };
          if (existing >= 0) tools[existing] = entry;
          else tools.push(entry);
          next[next.length - 1] = { ...last, tools };
          return next;
        });
      }
    });
  }, [liveConversationId, qc]);

  useEffect(() => {
    if (!conversationId || hydrated) return;
    let cancelled = false;
    (async () => {
      try {
        const data = await api.conversationMessages(conversationId);
        if (cancelled) return;
        const fromApi: ChatLine[] = data.messages
          .filter((m) => m.role === "user" || m.role === "assistant")
          .map((m) => ({
            role: m.role as "user" | "assistant",
            content: m.content,
          }));
        if (fromApi.length > 0) {
          setLines(fromApi);
        }
      } catch {
        /* keep sessionStorage cache if API history unavailable */
      } finally {
        if (!cancelled) setHydrated(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [conversationId, hydrated]);

  const nodes = useQuery({ queryKey: ["nodes"], queryFn: api.nodes, refetchInterval: 5000 });
  const servers = useQuery({ queryKey: ["servers"], queryFn: api.servers, refetchInterval: 4000 });
  const llm = useQuery({ queryKey: ["llm"], queryFn: api.getLlmSettings });
  const agents = useQuery({
    queryKey: ["agent-progress"],
    queryFn: api.agentProgress,
    refetchInterval: 15_000,
  });
  const achievements = useQuery({
    queryKey: ["achievements"],
    queryFn: api.achievements,
    refetchInterval: 20_000,
  });

  const chat = useMutation({
    mutationFn: (text: string) => api.chat(text, conversationId),
    onMutate: async (text) => {
      setLiveConversationId(conversationId);
      setLines((prev) => [
        ...prev,
        { role: "user", content: text },
        { role: "assistant", content: "", tools: [] },
      ]);
      setMessage("");
    },
    onSuccess: async (data) => {
      setConversationId(data.conversationId);
      setLiveConversationId(data.conversationId);
      setHydrated(true);
      setLines((prev) => {
        const next = [...prev];
        const last = next[next.length - 1];
        if (last?.role === "assistant") {
          next[next.length - 1] = {
            role: "assistant",
            content: data.reply || last.content,
            tools: data.toolTrace?.length ? data.toolTrace : last.tools,
            llmMode: data.llmMode,
          };
        }
        return next;
      });
      if (data.hostAchievements?.length) {
        setCelebration(`Achievement: ${data.hostAchievements[0]!.title}`);
        window.setTimeout(() => setCelebration(null), 5000);
      } else if (data.celebrations?.length) {
        const top = data.celebrations[0]!;
        setCelebration(
          top.leveledUp
            ? `${top.title} hit level ${top.level}`
            : `${top.title} +${top.xpGained} XP`,
        );
        window.setTimeout(() => setCelebration(null), 5000);
      }
      setLiveConversationId(undefined);
      await qc.invalidateQueries({ queryKey: ["servers"] });
      await qc.invalidateQueries({ queryKey: ["panel"] });
      await qc.invalidateQueries({ queryKey: ["agent-progress"] });
      await qc.invalidateQueries({ queryKey: ["achievements"] });
    },
    onError: () => {
      setLiveConversationId(undefined);
    },
  });

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    const text = message.trim();
    if (!text || chat.isPending) return;
    chat.mutate(text);
  }

  async function answerConfirm(approved: boolean) {
    if (!pendingConfirm || confirmBusy) return;
    setConfirmBusy(true);
    try {
      await api.confirm(pendingConfirm.requestId, approved);
      setPendingConfirm(null);
    } catch (err) {
      console.error(err);
    } finally {
      setConfirmBusy(false);
    }
  }

  return (
    <div className="workspace split">
      <section className="pane">
        <div className="stack">
          <div>
            <h2>Agent chat</h2>
            <p className="muted" style={{ margin: 0 }}>
              {user.displayName} · {llm.data?.llm.provider ?? "…"}
              {llm.data?.llm.model ? ` · ${llm.data.llm.model}` : ""}
              {" · "}
              <Link to="/settings">Model settings</Link>
            </p>
          </div>
          {celebration ? (
            <div className="celebration-banner" role="status" aria-live="polite">
              {celebration}
            </div>
          ) : null}
          {pendingConfirm ? (
            <div
              className="panel stack confirm-banner"
              role="alertdialog"
              aria-label="Host confirmation required"
              aria-live="assertive"
            >
              <h2 style={{ margin: 0 }}>Confirm action</h2>
              <p style={{ margin: 0 }}>{pendingConfirm.summary}</p>
              <div className="btn-row">
                <button
                  className="btn btn-primary"
                  type="button"
                  disabled={confirmBusy}
                  onClick={() => void answerConfirm(true)}
                >
                  Approve
                </button>
                <button
                  className="btn btn-ghost"
                  type="button"
                  disabled={confirmBusy}
                  onClick={() => void answerConfirm(false)}
                >
                  Deny
                </button>
              </div>
            </div>
          ) : null}
          <div className="panel">
            <div className="chat-log" aria-live="polite">
              {!hydrated ? (
                <div className="skeleton" aria-hidden>
                  <div className="skeleton-row" />
                  <div className="skeleton-row" />
                </div>
              ) : lines.length === 0 ? (
                <p className="muted">
                  Ask PlayOn to spin up a game for the LAN. Set a provider API key in Settings for real models —
                  mock mode can still create the demo fixture server.
                </p>
              ) : (
                lines.map((line, i) => {
                  const streaming =
                    chat.isPending && i === lines.length - 1 && line.role === "assistant";
                  return (
                    <div key={i} className={`msg ${line.role}${streaming ? " streaming" : ""}`}>
                      <span className="meta">{line.role === "user" ? "You" : "PlayOn"}</span>
                      {line.content}
                      {streaming ? <span className="stream-caret" aria-hidden /> : null}
                      {line.tools?.length ? (
                        <details className="tool-trace" open={streaming}>
                          <summary>Tool activity ({line.tools.length})</summary>
                          {line.tools.map((t, j) => (
                            <div key={j}>
                              <code>{t.name}</code>
                              {t.result === undefined ? (
                                <span className="muted"> · running</span>
                              ) : null}
                            </div>
                          ))}
                        </details>
                      ) : null}
                    </div>
                  );
                })
              )}
            </div>
            <form className="stack" onSubmit={onSubmit} style={{ marginTop: "0.85rem" }}>
              <label className="field">
                <span>Message</span>
                <textarea
                  value={message}
                  onChange={(e) => setMessage(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      const text = message.trim();
                      if (!text || chat.isPending) return;
                      chat.mutate(text);
                    }
                  }}
                  placeholder="Spin up a server for the LAN… (Enter to send, Shift+Enter for a new line)"
                  disabled={chat.isPending}
                />
              </label>
              <div className="btn-row">
                <button
                  className="btn btn-primary"
                  type="submit"
                  disabled={chat.isPending}
                  aria-busy={chat.isPending}
                >
                  {chat.isPending ? "Streaming…" : "Send"}
                </button>
              </div>
              {chat.isError ? <p className="error">{(chat.error as Error).message}</p> : null}
            </form>
          </div>
        </div>
      </section>

      <aside className="pane stack">
        <div className="panel">
          <h2>Agents</h2>
          {agents.data?.agents?.length ? (
            <ul className="list compact-list">
              {agents.data.agents.map((a) => (
                <li key={a.persona}>
                  <div>
                    <strong>{a.title}</strong>
                    <div className="muted">
                      Lv {a.level} · {a.xp} XP · {a.persona.replace(/_/g, " ")}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted" style={{ margin: 0 }}>
              Agents earn XP from successful tools — clean installs and recoveries celebrate.
            </p>
          )}
        </div>
        <div className="panel">
          <h2>Host trophies</h2>
          {achievements.data ? (
            <ul className="list compact-list achievement-list">
              {achievements.data.unlocked.map((a) => (
                <li key={a.id} className="achievement-unlocked">
                  <div>
                    <strong>{a.title}</strong>
                    <div className="muted">{a.description}</div>
                  </div>
                </li>
              ))}
              {achievements.data.locked.slice(0, 3).map((a) => (
                <li key={a.id} className="achievement-locked">
                  <div>
                    <strong>{a.title}</strong>
                    <div className="muted">{a.description}</div>
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted" style={{ margin: 0 }}>
              Host milestones unlock as you install, restore, and run the LAN.
            </p>
          )}
        </div>
        <div className="panel">
          <h2>Tonight</h2>
          <p className="muted">
            Glanceable status. Full controls live on <Link to="/servers">Servers</Link>.
          </p>
          {servers.isLoading ? (
            <div className="skeleton" aria-hidden>
              <div className="skeleton-row" />
              <div className="skeleton-row" />
            </div>
          ) : servers.data?.servers?.length ? (
            <ul className="list">
              {servers.data.servers.map((s) => (
                <li key={s.id}>
                  <div>
                    <strong>{s.name}</strong>
                    <div className="muted">{s.game ?? "game"}</div>
                  </div>
                  <span className={`status ${s.status === "running" ? "" : "stopped"}`}>{s.status}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted">No servers yet.</p>
          )}
        </div>
        <div className="panel">
          <h2>Machines</h2>
          {nodes.isLoading ? (
            <div className="skeleton" aria-hidden>
              <div className="skeleton-row" />
            </div>
          ) : nodes.data?.nodes?.length ? (
            <ul className="list">
              {nodes.data.nodes.map((n) => (
                <li key={n.id}>
                  <div>
                    <strong>{n.name}</strong>
                    <div className="muted">
                      {n.os}
                      {n.docker ? " · containers ready" : ""}
                    </div>
                  </div>
                  <span className={`status node-status node-${n.status}`}>{n.status}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted">Local agent not connected yet.</p>
          )}
        </div>
      </aside>
    </div>
  );
}
