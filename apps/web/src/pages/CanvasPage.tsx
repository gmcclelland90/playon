import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { PublicUser } from "@playon/shared";
import { api, type ToolTrace } from "../api";
import {
  clearConfirmPrefs,
  hasConfirmPrefs,
  setAlwaysApproveAll,
  setAlwaysApproveTool,
  shouldAutoApprove,
} from "../confirm-prefs";
import {
  AgentCanvas,
  skillShortLabel,
  type AgentActivityView,
} from "../components/agent-canvas/AgentCanvas";
import { MapAddNodePanel } from "../components/MapAddNodePanel";
import { runtimeErrorHint, statusHint, statusLabel } from "../status";
import { playonSocket } from "../ws";

type ChatLine = {
  role: "user" | "assistant";
  content: string;
  tools?: ToolTrace[];
};

type DockTab = "chat" | "ops";

type SkillRow = {
  skill: string;
  xp: number;
  level: number;
  title: string;
};

/** Fraction of XP earned toward the next level (same curve as the API). */
function xpBarFraction(xp: number): number {
  let need = 100;
  let remaining = Math.max(0, xp);
  let level = 1;
  while (remaining >= need && level < 99) {
    remaining -= need;
    level += 1;
    need = Math.floor(need * 1.35);
  }
  return need > 0 ? Math.min(1, remaining / need) : 0;
}

function AgentSkillsPanel({
  skills,
  loading,
  activeSkill,
}: {
  skills: SkillRow[];
  loading: boolean;
  activeSkill?: string;
}) {
  return (
    <div className="agent-skills">
      <div className="dash-section-head">
        <h4>Agent</h4>
        <span className="muted agent-skills-status">
          {activeSkill ? `Working · ${skillShortLabel(activeSkill)}` : "Idle"}
        </span>
      </div>
      {loading ? (
        <div className="skeleton" aria-hidden>
          <div className="skeleton-row compact" />
          <div className="skeleton-row compact" />
        </div>
      ) : skills.length === 0 ? (
        <p className="muted canvas-dock-hint">Loading skills…</p>
      ) : (
        <ul className="agent-skills-list">
          {skills.map((row) => {
            const busy = activeSkill === row.skill;
            const frac = xpBarFraction(row.xp);
            return (
              <li
                key={row.skill}
                className={busy ? "agent-skill-item busy" : "agent-skill-item"}
              >
                <span className={`agent-skill-pip skill-${row.skill}`} aria-hidden />
                <div className="agent-skill-meta">
                  <div className="agent-skill-head">
                    <strong>{skillShortLabel(row.skill)}</strong>
                    <span className="muted">Lv {row.level}</span>
                  </div>
                  <div
                    className="agent-skill-bar"
                    role="progressbar"
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={Math.round(frac * 100)}
                    aria-label={`${skillShortLabel(row.skill)} XP`}
                  >
                    <span style={{ width: `${Math.round(frac * 100)}%` }} />
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

export function CanvasPage({ user }: { user: PublicUser }) {
  const qc = useQueryClient();
  const [selectedId, setSelectedId] = useState<string | undefined>(() => {
    try {
      return localStorage.getItem("playon.lastServerId") ?? undefined;
    } catch {
      return undefined;
    }
  });
  /** Unbound install dock (no crate selected). */
  const [installOpen, setInstallOpen] = useState(false);
  const [conversationId, setConversationId] = useState<string | undefined>();
  const [lines, setLines] = useState<ChatLine[]>([]);
  const [message, setMessage] = useState("");
  const [activity, setActivity] = useState<AgentActivityView | undefined>();
  /** Last activity event timestamp (for stale idle clear). */
  const activityUpdatedAtRef = useRef(0);
  const [pendingConfirm, setPendingConfirm] = useState<{
    requestId: string;
    toolName: string;
    summary: string;
  } | null>(null);
  const [confirmBusy, setConfirmBusy] = useState(false);
  const [autoApproveActive, setAutoApproveActive] = useState(() => hasConfirmPrefs());
  const [celebration, setCelebration] = useState<string | null>(null);
  const [joinCopied, setJoinCopied] = useState(false);
  const confirmApproveRef = useRef<HTMLButtonElement>(null);
  const [liveConversationId, setLiveConversationId] = useState<string | undefined>();
  const [opsError, setOpsError] = useState<string | null>(null);
  const [sessionError, setSessionError] = useState<string | null>(null);
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState(false);
  const [dockTab, setDockTab] = useState<DockTab>("chat");
  const chatLogRef = useRef<HTMLDivElement>(null);

  const servers = useQuery({ queryKey: ["servers"], queryFn: api.servers, refetchInterval: 4000 });
  const nodes = useQuery({ queryKey: ["nodes"], queryFn: api.nodes, refetchInterval: 8_000 });
  const [addNodeOpen, setAddNodeOpen] = useState(false);
  const removeNodeMut = useMutation({
    mutationFn: (id: string) => api.removeNode(id),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["nodes"] });
    },
  });
  const agents = useQuery({
    queryKey: ["agents"],
    queryFn: api.agents,
    refetchInterval: 8000,
  });
  const detail = useQuery({
    queryKey: ["server-detail", selectedId],
    queryFn: () => api.serverDetail(selectedId!),
    enabled: Boolean(selectedId),
    refetchInterval: 5000,
  });

  const dockOpen = Boolean(selectedId) || installOpen;
  const unbound = !selectedId && installOpen;

  useEffect(() => {
    if (!selectedId || !servers.data?.servers.length) return;
    if (!servers.data.servers.some((s) => s.id === selectedId)) {
      setSelectedId(undefined);
    }
  }, [selectedId, servers.data?.servers]);

  function openInstallChat() {
    setSelectedId(undefined);
    setInstallOpen(true);
    setConversationId(undefined);
    setLines([]);
    setOpsError(null);
    setSessionError(null);
    setDockTab("chat");
    try {
      localStorage.removeItem("playon.lastServerId");
    } catch {
      /* ignore */
    }
  }

  function selectServer(id: string | undefined) {
    if (!id) {
      setSelectedId(undefined);
      setInstallOpen(false);
      return;
    }
    setInstallOpen(false);
    setSelectedId(id);
    setOpsError(null);
    setSessionError(null);
    setDockTab("chat");
  }

  useEffect(() => {
    return playonSocket.subscribe((event) => {
      if (event.type === "server.status") {
        void qc.invalidateQueries({ queryKey: ["servers"] });
        void qc.invalidateQueries({ queryKey: ["server-detail", event.serverId] });
        return;
      }
      if (event.type === "agent.activity") {
        activityUpdatedAtRef.current = Date.now();
        setActivity({
          serverId: event.serverId,
          skill: event.skill,
          phase: event.phase,
          verb: event.verb,
          label: event.label,
        });
        return;
      }
      if (event.type === "agent.celebration") {
        const msg = event.leveledUp
          ? `${event.title} hit level ${event.level}`
          : `${event.title} +${event.xpGained} XP`;
        setCelebration(msg);
        window.setTimeout(() => setCelebration(null), 4000);
        void qc.invalidateQueries({ queryKey: ["agents"] });
        return;
      }
      if (event.type === "confirm.required") {
        if (shouldAutoApprove(event.toolName)) {
          void api.confirm(event.requestId, true).catch(() => {
            setPendingConfirm({
              requestId: event.requestId,
              toolName: event.toolName,
              summary: event.summary,
            });
            setConfirmError("Could not auto-approve — please confirm manually.");
          });
          return;
        }
        setPendingConfirm({
          requestId: event.requestId,
          toolName: event.toolName,
          summary: event.summary,
        });
        setConfirmError(null);
        return;
      }
      if (event.type === "chat.token") {
        if (liveConversationId && event.conversationId !== liveConversationId) return;
        // Adopt id from first streamed token when install chat created the conversation mid-turn.
        if (!liveConversationId && event.conversationId) {
          setLiveConversationId(event.conversationId);
        }
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
        // Clear any leaked interim text when tools start so the bubble stays clean until the final reply.
        if (event.status === "started") {
          setLines((prev) => {
            const next = [...prev];
            const last = next[next.length - 1];
            if (!last || last.role !== "assistant" || !last.content) return prev;
            next[next.length - 1] = { ...last, content: "" };
            return next;
          });
        }
      }
    });
  }, [liveConversationId, qc]);

  /** Clear stuck busy labels if idle was dropped (WS gap / crash). */
  useEffect(() => {
    const STALE_MS = 90_000;
    const id = window.setInterval(() => {
      const now = Date.now();
      setActivity((prev) => {
        if (!prev || prev.phase === "idle") return prev;
        if (now - activityUpdatedAtRef.current < STALE_MS) return prev;
        return { ...prev, phase: "idle", label: "Idle" };
      });
    }, 15_000);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    if (!selectedId) {
      if (!installOpen) {
        setConversationId(undefined);
        setLines([]);
      }
      return;
    }
    localStorage.setItem("playon.lastServerId", selectedId);
    let cancelled = false;
    setSessionError(null);
    (async () => {
      try {
        const sessions = await api.serverConversations(selectedId);
        if (cancelled) return;
        let id = sessions.conversations[0]?.id;
        if (!id) {
          const created = await api.createServerConversation(selectedId);
          id = created.conversation.id;
        }
        setConversationId(id);
        const history = await api.conversationMessages(id);
        if (cancelled) return;
        setLines(
          history.messages
            .filter((m) => m.role === "user" || m.role === "assistant")
            .map((m) => ({
              role: m.role as "user" | "assistant",
              content: m.content,
            })),
        );
      } catch (err) {
        if (cancelled) return;
        setSessionError((err as Error).message || "Could not load chat history.");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedId, installOpen]);

  const refreshServer = async (serverId: string) => {
    await Promise.all([
      qc.invalidateQueries({ queryKey: ["servers"] }),
      qc.invalidateQueries({ queryKey: ["server-detail", serverId] }),
    ]);
  };

  const start = useMutation({
    mutationFn: (id: string) => api.startServer(id),
    onMutate: () => setOpsError(null),
    onSuccess: async (data) => {
      await refreshServer(data.server.id);
    },
    onError: (err) => setOpsError((err as Error).message),
  });
  const stop = useMutation({
    mutationFn: (id: string) => api.stopServer(id),
    onMutate: () => setOpsError(null),
    onSuccess: async (data) => {
      await refreshServer(data.server.id);
    },
    onError: (err) => setOpsError((err as Error).message),
  });
  const restart = useMutation({
    mutationFn: (id: string) => api.restartServer(id),
    onMutate: () => setOpsError(null),
    onSuccess: async (data) => {
      await refreshServer(data.server.id);
    },
    onError: (err) => setOpsError((err as Error).message),
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.deleteServer(id),
    onMutate: () => setOpsError(null),
    onSuccess: async () => {
      setPendingDelete(false);
      setSelectedId(undefined);
      setInstallOpen(false);
      setConversationId(undefined);
      setLines([]);
      await qc.invalidateQueries({ queryKey: ["servers"] });
      try {
        localStorage.removeItem("playon.lastServerId");
      } catch {
        /* ignore */
      }
    },
    onError: (err) => setOpsError((err as Error).message),
  });

  const opsBusy =
    start.isPending || stop.isPending || restart.isPending || remove.isPending;

  const chat = useMutation({
    mutationFn: (text: string) => {
      if (selectedId) {
        return api.chat(text, { conversationId, serverId: selectedId });
      }
      return api.chat(text, { conversationId });
    },
    onMutate: (text) => {
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
      setLiveConversationId(undefined);
      setLines((prev) => {
        const next = [...prev];
        const last = next[next.length - 1];
        if (last?.role === "assistant") {
          next[next.length - 1] = {
            role: "assistant",
            // Prefer the HTTP final reply; streamed interim text must not win if reply is empty.
            content: typeof data.reply === "string" ? data.reply : last.content,
            tools: data.toolTrace?.length ? data.toolTrace : last.tools,
          };
        }
        return next;
      });
      if (data.celebrations?.length) {
        const top = data.celebrations[0]!;
        setCelebration(
          top.leveledUp ? `${top.title} hit level ${top.level}` : `${top.title} +${top.xpGained} XP`,
        );
        window.setTimeout(() => setCelebration(null), 4000);
      }
      await qc.invalidateQueries({ queryKey: ["servers"] });
      await qc.invalidateQueries({ queryKey: ["agents"] });
      if (data.serverId) {
        await qc.invalidateQueries({ queryKey: ["server-detail", data.serverId] });
      }
      if (data.serverId && data.serverId !== selectedId) {
        setInstallOpen(false);
        setSelectedId(data.serverId);
        localStorage.setItem("playon.lastServerId", data.serverId);
      }
    },
    onError: () => {
      setLiveConversationId(undefined);
      setLines((prev) => {
        const next = [...prev];
        const last = next[next.length - 1];
        if (last?.role === "assistant" && !last.content) next.pop();
        return next;
      });
    },
  });

  useEffect(() => {
    const el = chatLogRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [lines, chat.isPending]);

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    const text = message.trim();
    if (!text || !dockOpen || chat.isPending) return;
    chat.mutate(text);
  }

  function onComposerKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key !== "Enter" || e.shiftKey) return;
    e.preventDefault();
    const text = message.trim();
    if (!text || !dockOpen || chat.isPending) return;
    chat.mutate(text);
  }

  async function answerConfirm(decision: "approve" | "deny" | "always-tool" | "always-all") {
    if (!pendingConfirm || confirmBusy) return;
    setConfirmBusy(true);
    setConfirmError(null);
    try {
      if (decision === "always-tool") {
        setAlwaysApproveTool(pendingConfirm.toolName);
        setAutoApproveActive(true);
      } else if (decision === "always-all") {
        setAlwaysApproveAll();
        setAutoApproveActive(true);
      }
      const approved = decision !== "deny";
      await api.confirm(pendingConfirm.requestId, approved);
      setPendingConfirm(null);
    } catch (err) {
      setConfirmError((err as Error).message || "Confirmation failed.");
    } finally {
      setConfirmBusy(false);
    }
  }

  function resetAutoApprovals() {
    clearConfirmPrefs();
    setAutoApproveActive(false);
  }

  useEffect(() => {
    if (!pendingConfirm) return;
    confirmApproveRef.current?.focus();
  }, [pendingConfirm]);

  const selected = servers.data?.servers.find((s) => s.id === selectedId);
  const status = detail.data?.server.status ?? selected?.status ?? "unknown";
  const join = detail.data?.runtime.join;
  const activityOnSelected =
    selectedId && activity && activity.serverId === selectedId && activity.phase !== "idle"
      ? activity
      : undefined;
  const skills = agents.data?.skills ?? [];
  const activeSkill =
    activity && activity.phase !== "idle" ? activity.skill : undefined;
  const dockTitle = selected?.name ?? "New server";
  const dockHint = unbound
    ? `${user.displayName} · tell the agent what to install`
    : `${user.displayName} · ask the agent to maintain this server`;
  const emptyHint = unbound
    ? "Try “I want a vanilla Minecraft server”."
    : "Ask about status, config, restarts, snapshots…";

  return (
    <div className="canvas-page">
      <AgentCanvas
        servers={servers.data?.servers ?? []}
        nodes={(nodes.data?.nodes ?? []).map((n) => ({
          id: n.id,
          name: n.name,
          kind: n.kind,
          status: n.status,
          agentVersion: n.agentVersion,
          joinHost: n.joinHost,
          badge: n.badge,
        }))}
        serversLoading={servers.isLoading || (servers.isFetching && !servers.data)}
        selectedId={selectedId}
        activity={activity}
        skills={skills.map((s) => ({
          skill: s.skill,
          level: s.level,
          title: s.title,
        }))}
        onSelect={selectServer}
        onDescribe={openInstallChat}
        onAddServer={openInstallChat}
        onAddNode={() => setAddNodeOpen(true)}
        onRemoveNode={(id) => removeNodeMut.mutate(id)}
        showAddButton={!dockOpen && !addNodeOpen}
      />

      {addNodeOpen ? (
        <div className="map-add-node-overlay">
          <MapAddNodePanel onClose={() => setAddNodeOpen(false)} />
        </div>
      ) : null}

      {celebration ? (
        <div className="celebration-banner canvas-toast" role="status">
          {celebration}
        </div>
      ) : null}

      {dockOpen ? (
        <aside
          className={`canvas-chat-dock dock-tab-${dockTab}`}
          aria-label={`Chat for ${dockTitle}`}
        >
          <div className="canvas-dock-head">
            <div className="dash-section-head">
              <h3>{dockTitle}</h3>
              <div className="btn-row">
                {selectedId ? (
                  <button type="button" className="linkish" onClick={openInstallChat}>
                    + Add
                  </button>
                ) : null}
                <button
                  type="button"
                  className="linkish"
                  onClick={() => {
                    setSelectedId(undefined);
                    setInstallOpen(false);
                  }}
                >
                  Close
                </button>
              </div>
            </div>
            <p className="canvas-dock-hint">{dockHint}</p>
            {sessionError ? <p className="error">{sessionError}</p> : null}
            {servers.isError ? (
              <p className="error">{(servers.error as Error).message}</p>
            ) : null}
            {selected && selectedId ? (
              <>
                <div className="canvas-status-row">
                  <span className={`server-status-pill status-${status}`}>{statusLabel(status)}</span>
                  {selected.game ? <span className="muted">{selected.game}</span> : null}
                  {activityOnSelected ? (
                    <span className="muted canvas-busy-hint">
                      {skillShortLabel(activityOnSelected.skill)} ·{" "}
                      {activityOnSelected.label ?? activityOnSelected.verb}
                    </span>
                  ) : null}
                </div>
                {join ? (
                  <div className="canvas-join-card">
                    <div className="dash-section-head">
                      <span className="chip">Join</span>
                      <button
                        type="button"
                        className="btn btn-ghost btn-compact"
                        onClick={() => {
                          const endpoint = `${join.address}:${join.port}`;
                          void navigator.clipboard.writeText(endpoint).then(
                            () => {
                              setJoinCopied(true);
                              window.setTimeout(() => setJoinCopied(false), 2000);
                            },
                            () => setJoinCopied(false),
                          );
                        }}
                      >
                        {joinCopied ? "Copied" : "Copy"}
                      </button>
                    </div>
                    <p className="canvas-join-endpoint">
                      {join.address}:{join.port}
                    </p>
                  </div>
                ) : null}
              </>
            ) : null}
            {selectedId ? (
              <div
                className="canvas-dock-tabs"
                role="tablist"
                aria-label="Dock sections"
                onKeyDown={(e) => {
                  if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
                  e.preventDefault();
                  setDockTab((tab) => (tab === "chat" ? "ops" : "chat"));
                }}
              >
                <button
                  type="button"
                  role="tab"
                  id="dock-tab-chat"
                  aria-controls="dock-panel-chat"
                  aria-selected={dockTab === "chat"}
                  tabIndex={dockTab === "chat" ? 0 : -1}
                  className={dockTab === "chat" ? "active" : undefined}
                  onClick={() => setDockTab("chat")}
                >
                  Chat
                </button>
                <button
                  type="button"
                  role="tab"
                  id="dock-tab-ops"
                  aria-controls="dock-panel-ops"
                  aria-selected={dockTab === "ops"}
                  tabIndex={dockTab === "ops" ? 0 : -1}
                  className={dockTab === "ops" ? "active" : undefined}
                  onClick={() => setDockTab("ops")}
                >
                  Controls
                </button>
              </div>
            ) : null}
          </div>

          {selected && selectedId ? (
            <div
              className="canvas-maintain stack"
              id="dock-panel-ops"
              role="tabpanel"
              aria-labelledby="dock-tab-ops"
              hidden={dockTab !== "ops"}
            >
              {statusHint(status) || runtimeErrorHint(status) ? (
                <p className="muted canvas-dock-hint">
                  {statusHint(status) ?? runtimeErrorHint(status)}
                </p>
              ) : null}
              <div className="btn-row">
                <button
                  type="button"
                  className="btn btn-primary btn-compact"
                  disabled={opsBusy || status === "running" || status === "starting"}
                  onClick={() => start.mutate(selectedId)}
                >
                  {start.isPending ? "Starting…" : "Start"}
                </button>
                <button
                  type="button"
                  className="btn btn-ghost btn-compact"
                  disabled={opsBusy || status === "stopped" || status === "stopping"}
                  onClick={() => stop.mutate(selectedId)}
                >
                  {stop.isPending ? "Stopping…" : "Stop"}
                </button>
                <button
                  type="button"
                  className="btn btn-ghost btn-compact"
                  disabled={opsBusy}
                  onClick={() => restart.mutate(selectedId)}
                >
                  {restart.isPending ? "Restarting…" : "Restart"}
                </button>
                <button
                  type="button"
                  className="btn btn-ghost btn-compact btn-danger"
                  disabled={opsBusy}
                  onClick={() => setPendingDelete(true)}
                >
                  Remove
                </button>
              </div>
              {pendingDelete ? (
                <div
                  className="confirm-banner panel stack"
                  role="alertdialog"
                  aria-label="Confirm server removal"
                >
                  <p className="status-inline">
                    Permanently remove <strong>{dockTitle}</strong>? This stops the game, deletes the
                    Docker container, wipes server files, chats, snapshots, and clears the player
                    panel for this server.
                  </p>
                  <div className="btn-row">
                    <button
                      type="button"
                      className="btn btn-primary"
                      disabled={remove.isPending}
                      onClick={() => remove.mutate(selectedId)}
                    >
                      {remove.isPending ? "Removing…" : "Yes, remove"}
                    </button>
                    <button
                      type="button"
                      className="btn btn-ghost"
                      disabled={remove.isPending}
                      onClick={() => setPendingDelete(false)}
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              ) : null}
              {opsError ? <p className="error">{opsError}</p> : null}

              <AgentSkillsPanel
                skills={skills}
                loading={agents.isLoading}
                activeSkill={activeSkill}
              />
            </div>
          ) : null}

          {unbound ? (
            <AgentSkillsPanel
              skills={skills}
              loading={agents.isLoading}
              activeSkill={activeSkill}
            />
          ) : null}

          {pendingConfirm ? (
            <div
              className="confirm-banner panel stack"
              role="alertdialog"
              aria-label="Permission needed"
              aria-busy={confirmBusy || undefined}
              onKeyDown={(e) => {
                if (e.key === "Escape" && !confirmBusy) {
                  e.preventDefault();
                  void answerConfirm("deny");
                }
              }}
            >
              <strong className="confirm-banner-title">Permission needed</strong>
              <p className="status-inline">{pendingConfirm.summary}</p>
              <div className="btn-row confirm-actions">
                <button
                  type="button"
                  className="btn btn-primary"
                  ref={confirmApproveRef}
                  disabled={confirmBusy}
                  onClick={() => void answerConfirm("approve")}
                >
                  {confirmBusy ? "Sending…" : "Approve"}
                </button>
                <button
                  type="button"
                  className="btn btn-ghost"
                  disabled={confirmBusy}
                  onClick={() => void answerConfirm("deny")}
                >
                  Deny
                </button>
              </div>
              <details className="confirm-always-details">
                <summary>Remember for later</summary>
                <div className="btn-row confirm-actions">
                  <button
                    type="button"
                    className="btn btn-ghost btn-compact"
                    disabled={confirmBusy}
                    onClick={() => void answerConfirm("always-tool")}
                  >
                    Always allow this tool
                  </button>
                  <button
                    type="button"
                    className="btn btn-ghost btn-compact btn-danger"
                    disabled={confirmBusy}
                    onClick={() => void answerConfirm("always-all")}
                  >
                    Always allow all tools
                  </button>
                </div>
              </details>
              {confirmError ? <p className="error">{confirmError}</p> : null}
            </div>
          ) : null}

          {autoApproveActive && !pendingConfirm ? (
            <p className="confirm-prefs-note muted">
              Some agent actions are auto-approved.{" "}
              <button type="button" className="linkish" onClick={resetAutoApprovals}>
                Reset
              </button>
            </p>
          ) : null}

          <div
            className="chat-log canvas-chat-log"
            id="dock-panel-chat"
            role="tabpanel"
            aria-labelledby="dock-tab-chat"
            hidden={Boolean(selectedId) && dockTab !== "chat"}
            ref={chatLogRef}
            aria-live="polite"
          >
            {lines.length === 0 ? (
              <div className="empty-hint">
                <strong>{unbound ? "Describe what to install" : "Ask the cast"}</strong>
                <p className="muted status-inline">{emptyHint}</p>
              </div>
            ) : (
              lines.map((line, i) => {
                const streaming =
                  chat.isPending && line.role === "assistant" && i === lines.length - 1;
                return (
                  <div
                    key={i}
                    className={`msg ${line.role}${streaming ? " streaming" : ""}`}
                  >
                    <span className="meta">{line.role === "user" ? "You" : "Agent"}</span>
                    {line.content}
                    {streaming ? <span className="stream-caret" aria-hidden /> : null}
                    {line.tools?.length ? (
                      <details className="tool-trace">
                        <summary>Tools ({line.tools.length})</summary>
                        <ul className="list compact-list">
                          {line.tools.map((tool, ti) => (
                            <li key={`${tool.name}-${ti}`}>
                              <code>{tool.name}</code>
                            </li>
                          ))}
                        </ul>
                      </details>
                    ) : null}
                  </div>
                );
              })
            )}
          </div>

          <form className="stack canvas-chat-composer" onSubmit={onSubmit}>
            <label className="field">
              <span className="sr-only">Message</span>
              <textarea
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                onKeyDown={onComposerKeyDown}
                placeholder={
                  unbound ? "Describe the server you want…" : "Tell the agents what you need…"
                }
                disabled={chat.isPending}
                rows={2}
                aria-label="Message the agents"
              />
            </label>
            <div className="btn-row">
              <button
                type="submit"
                className="btn btn-primary"
                disabled={chat.isPending || !message.trim()}
              >
                {chat.isPending ? "Working…" : "Send"}
              </button>
              <span className="muted canvas-busy-hint">Enter to send · Shift+Enter for line</span>
            </div>
            {chat.isError ? <p className="error">{(chat.error as Error).message}</p> : null}
          </form>
        </aside>
      ) : null}
    </div>
  );
}
