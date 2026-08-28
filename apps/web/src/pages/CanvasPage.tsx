import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  attachBoundComposeToServer,
  COMPOSE_CHANNEL_KEY,
  composeNeedsFreshConversation,
  listChatChannels,
  nowLineForTool,
  parseChatChannelKey,
  routeConversationToChannelKey,
  serverChannelKey,
  type ChatChannelRecord,
  type ChatProgressStep,
  type PublicUser,
} from "@playon/shared";
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
  type SelectedAnchor,
} from "../components/agent-canvas/AgentCanvas";
import { ChatChannelList } from "../components/ChatChannelList";
import { ChatNowLine } from "../components/ChatNowLine";
import { ChatMarkdown } from "../components/ChatMarkdown";
import { chatNowView } from "../chat-now";
import { mergeNodeContainerInventory } from "../components/agent-canvas/map-node-layout";
import { MapAddNodePanel } from "../components/MapAddNodePanel";
import { MapManageSuggestPanel } from "../components/MapManageSuggestPanel";
import { ServerConsoleBubble } from "../components/ServerConsoleBubble";
import { formatServerUsage } from "../format-usage";
import { displayServerStatus, runtimeErrorHint, statusHint, statusLabel } from "../status";
import { playonSocket } from "../ws";

function isAbortError(err: unknown): boolean {
  return (
    (err instanceof DOMException && err.name === "AbortError") ||
    (err instanceof Error && err.name === "AbortError")
  );
}

type ChatLine = {
  role: "user" | "assistant";
  content: string;
  tools?: ToolTrace[];
  degradedMode?: boolean;
};

type ChannelProgress = {
  phase: string;
  now: string;
  thinking?: string;
  steps: ChatProgressStep[];
  updatedAt: number;
};

type ChannelRecord = ChatChannelRecord<ChannelProgress, ChatLine> & {
  sessionError?: string | null;
};

const emptyChannel = (): ChannelRecord => ({
  lines: [],
  progress: null,
  pending: false,
  sessionError: null,
});

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
  const [activeKey, setActiveKey] = useState<string>(() =>
    selectedId ? serverChannelKey(selectedId) : "",
  );
  const [channels, setChannels] = useState<Record<string, ChannelRecord>>({});
  const [message, setMessage] = useState("");
  const [activity, setActivity] = useState<AgentActivityView | undefined>();
  /** Last activity event timestamp (for stale idle clear). */
  const activityUpdatedAtRef = useRef(0);
  const channelsRef = useRef(channels);
  channelsRef.current = channels;
  const activeKeyRef = useRef(activeKey);
  activeKeyRef.current = activeKey;
  const chatAbortRef = useRef<Record<string, AbortController>>({});
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
  const [opsError, setOpsError] = useState<string | null>(null);
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState(false);
  const [dockTab, setDockTab] = useState<DockTab>("chat");
  const [consoleOpen, setConsoleOpen] = useState(true);
  const [selectedAnchor, setSelectedAnchor] = useState<SelectedAnchor | null>(null);
  const chatLogRef = useRef<HTMLDivElement>(null);

  const servers = useQuery({ queryKey: ["servers"], queryFn: api.servers, refetchInterval: 4000 });
  const nodes = useQuery({ queryKey: ["nodes"], queryFn: api.nodes, refetchInterval: 8_000 });
  const [addNodeOpen, setAddNodeOpen] = useState(false);
  const [scanNodeId, setScanNodeId] = useState<string | null>(null);
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

  const composeActive = activeKey === COMPOSE_CHANNEL_KEY;
  const dockOpen = Boolean(selectedId) || composeActive;
  const unbound = composeActive;
  const activeChannel = channels[activeKey] ?? emptyChannel();
  const lines = activeChannel.lines;
  const chatProgress = activeChannel.progress;
  const sessionError = activeChannel.sessionError ?? null;
  const chatPending = activeChannel.pending;

  useEffect(() => {
    if (!selectedId || !servers.data?.servers.length) return;
    if (!servers.data.servers.some((s) => s.id === selectedId)) {
      if (activeKey === serverChannelKey(selectedId)) setActiveKey("");
      setSelectedId(undefined);
      setConsoleOpen(false);
      setSelectedAnchor(null);
    }
  }, [selectedId, servers.data?.servers]);

  function patchChannel(key: string, fn: (prev: ChannelRecord) => ChannelRecord) {
    setChannels((prev) => {
      const next = { ...prev, [key]: fn(prev[key] ?? emptyChannel()) };
      channelsRef.current = next;
      return next;
    });
  }

  function openInstallChat() {
    setSelectedId(undefined);
    setActiveKey(COMPOSE_CHANNEL_KEY);
    setOpsError(null);
    setDockTab("chat");
    setConsoleOpen(false);
    setSelectedAnchor(null);
    try {
      localStorage.removeItem("playon.lastServerId");
    } catch {
      /* ignore */
    }
    void ensureComposeConversation();
  }

  function clearMapSelection() {
    setSelectedId(undefined);
    setActiveKey("");
    setConsoleOpen(false);
    setSelectedAnchor(null);
    setScanNodeId(null);
    setAddNodeOpen(false);
    setOpsError(null);
    try {
      localStorage.removeItem("playon.lastServerId");
    } catch {
      /* ignore */
    }
  }

  function selectServer(id: string | undefined) {
    if (!id) {
      clearMapSelection();
      return;
    }
    setScanNodeId(null);
    setAddNodeOpen(false);
    if (id !== selectedId) {
      setConsoleOpen(false);
    }
    setSelectedId(id);
    setActiveKey(serverChannelKey(id));
    setOpsError(null);
    setDockTab("chat");
    void ensureServerConversation(id);
  }

  function selectChannel(key: string) {
    const parsed = parseChatChannelKey(key);
    if (parsed.kind === "compose") {
      openInstallChat();
      return;
    }
    selectServer(parsed.serverId);
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
          thinking: event.thinking,
        });
        const key = event.conversationId
          ? routeConversationToChannelKey(
              channelsRef.current,
              event.conversationId,
              event.serverId,
            )
          : activeKeyRef.current || COMPOSE_CHANNEL_KEY;
        patchChannel(key, (prev) => ({
          ...prev,
          conversationId: event.conversationId ?? prev.conversationId,
          boundServerId: event.serverId ?? prev.boundServerId,
          progress: {
            phase: event.phase,
            now: event.label ?? prev.progress?.now ?? "Thinking…",
            thinking: event.thinking ?? prev.progress?.thinking,
            steps: event.steps ?? prev.progress?.steps ?? [],
            updatedAt: Date.now(),
          },
        }));
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
        const key = routeConversationToChannelKey(
          channelsRef.current,
          event.conversationId,
        );
        patchChannel(key, (prev) => {
          const next = [...prev.lines];
          const last = next[next.length - 1];
          if (!last || last.role !== "assistant") return prev;
          next[next.length - 1] = { ...last, content: `${last.content}${event.token}` };
          return { ...prev, conversationId: event.conversationId, lines: next };
        });
        return;
      }
      if (event.type === "chat.tool") {
        const key = routeConversationToChannelKey(
          channelsRef.current,
          event.conversationId,
        );
        if (event.status === "started") {
          patchChannel(key, (prev) => {
            const next = [...prev.lines];
            const last = next[next.length - 1];
            if (!last || last.role !== "assistant" || !last.content) return prev;
            next[next.length - 1] = { ...last, content: "" };
            return { ...prev, conversationId: event.conversationId, lines: next };
          });
        }
      }
    });
  }, [qc]);

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

  function writeChannel(key: string, next: ChannelRecord) {
    channelsRef.current = { ...channelsRef.current, [key]: next };
    patchChannel(key, () => next);
  }

  async function ensureServerConversation(serverId: string): Promise<string | undefined> {
    const key = serverChannelKey(serverId);
    const existing = channelsRef.current[key];
    if (existing?.pending || existing?.conversationId) return existing.conversationId;
    try {
      const sessions = await api.serverConversations(serverId);
      let id = sessions.conversations[0]?.id;
      if (!id) {
        const created = await api.createServerConversation(serverId);
        id = created.conversation.id;
      }
      const current = channelsRef.current[key];
      if (current?.pending || current?.conversationId) return current.conversationId;
      const history = await api.conversationMessages(id);
      writeChannel(key, {
        ...(current ?? emptyChannel()),
        conversationId: id,
        boundServerId: serverId,
        sessionError: null,
        lines: history.messages
          .filter((m) => m.role === "user" || m.role === "assistant")
          .map((m) => ({
            role: m.role as "user" | "assistant",
            content: m.content,
          })),
      });
      return id;
    } catch (err) {
      patchChannel(key, (prev) => ({
        ...prev,
        sessionError: (err as Error).message || "Could not load chat history.",
      }));
      return undefined;
    }
  }

  async function ensureComposeConversation(): Promise<string | undefined> {
    const existing = channelsRef.current[COMPOSE_CHANNEL_KEY];
    if (!composeNeedsFreshConversation(existing)) return existing?.conversationId;
    try {
      const listed = await api.unboundConversations();
      let id = listed.conversations[0]?.id;
      if (!id) {
        const created = await api.createConversation("Add server");
        id = created.conversation.id;
      }
      const current = channelsRef.current[COMPOSE_CHANNEL_KEY];
      if (!composeNeedsFreshConversation(current)) return current?.conversationId;
      const history = id ? await api.conversationMessages(id) : { messages: [] };
      writeChannel(COMPOSE_CHANNEL_KEY, {
        ...(current ?? emptyChannel()),
        conversationId: id,
        boundServerId: undefined,
        sessionError: null,
        lines: history.messages
          .filter((m) => m.role === "user" || m.role === "assistant")
          .map((m) => ({
            role: m.role as "user" | "assistant",
            content: m.content,
          })),
      });
      return id;
    } catch (err) {
      patchChannel(COMPOSE_CHANNEL_KEY, (prev) => ({
        ...prev,
        sessionError: (err as Error).message || "Could not open add-server chat.",
      }));
      return undefined;
    }
  }

  useEffect(() => {
    if (!selectedId) return;
    localStorage.setItem("playon.lastServerId", selectedId);
    void ensureServerConversation(selectedId);
  }, [selectedId]);

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
    onSuccess: async (_data, id) => {
      setPendingDelete(false);
      setChannels((prev) => {
        const next = { ...prev };
        delete next[serverChannelKey(id)];
        return next;
      });
      if (activeKey === serverChannelKey(id)) {
        setSelectedId(undefined);
        setActiveKey("");
      }
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

  const startMutateRef = useRef(start.mutate);
  const stopMutateRef = useRef(stop.mutate);
  startMutateRef.current = start.mutate;
  stopMutateRef.current = stop.mutate;

  useEffect(() => {
    function onKey(e: globalThis.KeyboardEvent) {
      const t = e.target as HTMLElement | null;
      if (
        t &&
        (t.tagName === "INPUT" ||
          t.tagName === "TEXTAREA" ||
          t.tagName === "SELECT" ||
          t.isContentEditable)
      ) {
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        clearMapSelection();
        return;
      }
      if (e.key === "a" || e.key === "A") {
        e.preventDefault();
        openInstallChat();
        return;
      }
      if ((e.key === "n" || e.key === "N") && !scanNodeId) {
        e.preventDefault();
        setScanNodeId(null);
        setAddNodeOpen(true);
        return;
      }
      if (selectedId && (e.key === "s" || e.key === "S") && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        startMutateRef.current(selectedId);
        return;
      }
      if (selectedId && (e.key === "x" || e.key === "X") && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        stopMutateRef.current(selectedId);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [scanNodeId, selectedId]);

  const [chatSendError, setChatSendError] = useState<string | null>(null);

  async function sendOnChannel(key: string, text: string) {
    const channel = channelsRef.current[key] ?? emptyChannel();
    if (channel.pending) return;
    let conversationId = channel.conversationId;
    if (key === COMPOSE_CHANNEL_KEY) {
      conversationId = (await ensureComposeConversation()) ?? conversationId;
    } else {
      const parsed = parseChatChannelKey(key);
      if (parsed.kind === "server") {
        conversationId = (await ensureServerConversation(parsed.serverId)) ?? conversationId;
      }
    }
    if (!conversationId) {
      patchChannel(key, (prev) => ({
        ...prev,
        sessionError: prev.sessionError ?? "Could not open this chat session.",
      }));
      return;
    }
    const ac = new AbortController();
    chatAbortRef.current[key] = ac;
    setChatSendError(null);
    setMessage("");
    patchChannel(key, (prev) => ({
      ...prev,
      conversationId: conversationId ?? prev.conversationId,
      pending: true,
      progress: {
        phase: "thinking",
        now: "Thinking…",
        steps: [],
        updatedAt: Date.now(),
      },
      lines: [
        ...prev.lines,
        { role: "user", content: text },
        { role: "assistant", content: "", tools: [] },
      ],
    }));
    try {
      const parsed = parseChatChannelKey(key);
      const data = await api.chat(text, {
        conversationId,
        serverId: parsed.kind === "server" ? parsed.serverId : undefined,
        signal: ac.signal,
      });
      patchChannel(key, (prev) => {
        const next = [...prev.lines];
        const last = next[next.length - 1];
        if (last?.role === "assistant") {
          next[next.length - 1] = {
            role: "assistant",
            content: typeof data.reply === "string" ? data.reply : last.content,
            tools: data.toolTrace?.length ? data.toolTrace : last.tools,
            degradedMode: data.degradedMode,
          };
        }
        const snapshot: ChannelRecord = {
          ...prev,
          conversationId: data.conversationId,
          boundServerId: data.serverId ?? prev.boundServerId,
          pending: false,
          progress: {
            phase: "idle",
            now: "Done",
            thinking: prev.progress?.thinking,
            steps: prev.progress?.steps ?? [],
            updatedAt: Date.now(),
          },
          lines: next,
        };
        return snapshot;
      });
      if (data.serverId && key === COMPOSE_CHANNEL_KEY) {
        const compose = channelsRef.current[COMPOSE_CHANNEL_KEY];
        if (compose) {
          setChannels((prev) => {
            const next = attachBoundComposeToServer(prev, data.serverId!, {
              ...compose,
              conversationId: data.conversationId,
              boundServerId: data.serverId,
              pending: false,
            });
            channelsRef.current = next;
            return next;
          });
        }
      }
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
    } catch (err) {
      if (isAbortError(err)) {
        patchChannel(key, (prev) => {
          const next = [...prev.lines];
          const last = next[next.length - 1];
          if (last?.role === "assistant" && !last.content.trim()) {
            next[next.length - 1] = { ...last, content: "Stopped." };
          }
          return {
            ...prev,
            pending: false,
            progress: {
              phase: "idle",
              now: "Stopped",
              thinking: prev.progress?.thinking,
              steps: prev.progress?.steps ?? [],
              updatedAt: Date.now(),
            },
            lines: next,
          };
        });
        return;
      }
      patchChannel(key, (prev) => {
        const next = [...prev.lines];
        const last = next[next.length - 1];
        if (last?.role === "assistant" && !last.content) next.pop();
        return {
          ...prev,
          pending: false,
          progress: prev.progress
            ? { ...prev.progress, phase: "idle", now: "Done", updatedAt: Date.now() }
            : null,
          lines: next,
        };
      });
      setChatSendError((err as Error).message);
    } finally {
      delete chatAbortRef.current[key];
    }
  }

  useEffect(() => {
    const el = chatLogRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [lines, chatPending, chatProgress]);

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    const text = message.trim();
    if (!text || !dockOpen || chatPending || !activeKey) return;
    void sendOnChannel(activeKey, text);
  }

  function onComposerKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key !== "Enter" || e.shiftKey) return;
    e.preventDefault();
    const text = message.trim();
    if (!text || !dockOpen || chatPending || !activeKey) return;
    void sendOnChannel(activeKey, text);
  }

  function stopChat() {
    if (activeKey) chatAbortRef.current[activeKey]?.abort();
    if (pendingConfirm) {
      const requestId = pendingConfirm.requestId;
      setPendingConfirm(null);
      setConfirmError(null);
      void api.confirm(requestId, false).catch(() => {
        /* ignore — server abort also denies */
      });
    }
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

  const mapServers = useMemo(
    () => mergeNodeContainerInventory(servers.data?.servers ?? [], nodes.data?.nodes ?? []),
    [servers.data?.servers, nodes.data?.nodes],
  );
  const selected = servers.data?.servers.find((s) => s.id === selectedId);
  const processStatus = detail.data?.server.status ?? selected?.status ?? "unknown";
  const ready = detail.data?.runtime.ready ?? detail.data?.server.ready ?? selected?.ready;
  const status = displayServerStatus(processStatus, ready);
  const join = detail.data?.runtime.join;
  const activityOnSelected =
    selectedId && activity && activity.serverId === selectedId && activity.phase !== "idle"
      ? activity
      : undefined;
  const skills = agents.data?.skills ?? [];
  const activeSkill =
    activity && activity.phase !== "idle" ? activity.skill : undefined;
  const dockTitle = selected?.name ?? (composeActive ? "Add server" : "Chat");
  const dockHint = unbound
    ? `${user.displayName} · tell the agent what to install`
    : `${user.displayName} · ask the agent to maintain this server`;
  const emptyHint = unbound
    ? "Try “I want a vanilla Minecraft server”."
    : "Ask about status, config, restarts, snapshots…";
  const channelItems = listChatChannels({
    servers: (servers.data?.servers ?? []).filter((s) => !s.unmanaged),
    compose: {
      pending: Boolean(channels[COMPOSE_CHANNEL_KEY]?.pending),
      conversationId: channels[COMPOSE_CHANNEL_KEY]?.conversationId,
    },
    pendingByServer: Object.fromEntries(
      (servers.data?.servers ?? []).map((s) => [
        s.id,
        Boolean(channels[serverChannelKey(s.id)]?.pending),
      ]),
    ),
    conversationByServer: Object.fromEntries(
      (servers.data?.servers ?? []).map((s) => [
        s.id,
        channels[serverChannelKey(s.id)]?.conversationId,
      ]),
    ),
  });
  const nowView = chatNowView({
    pending: chatPending,
    phase: chatProgress?.phase,
    now: chatProgress?.now,
    thinking: chatProgress?.thinking,
    steps: chatProgress?.steps,
    updatedAt: chatProgress?.updatedAt,
  });

  const pageClass = [
    "canvas-page",
    dockOpen ? "map-dock-open" : "",
    scanNodeId || addNodeOpen ? "map-overlay-open" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div className={pageClass}>
      <AgentCanvas
        servers={mapServers}
        nodes={(nodes.data?.nodes ?? []).map((n) => ({
          id: n.id,
          name: n.name,
          kind: n.kind,
          status: n.status,
          agentVersion: n.agentVersion,
          joinHost: n.joinHost,
          badge: n.badge,
          cpuPercent: n.cpuPercent,
          memUsedBytes: n.memUsedBytes,
          memTotalBytes: n.memTotalBytes,
          freeDiskBytes: n.freeDiskBytes,
        }))}
        serversLoading={servers.isLoading || (servers.isFetching && !servers.data)}
        selectedId={selectedId}
        selectedHostId={scanNodeId}
        activity={activity}
        skills={skills.map((s) => ({
          skill: s.skill,
          level: s.level,
          title: s.title,
        }))}
        onSelect={selectServer}
        onDescribe={openInstallChat}
        onAddServer={openInstallChat}
        onAddNode={() => {
          setScanNodeId(null);
          setAddNodeOpen(true);
        }}
        onRemoveNode={(id) => removeNodeMut.mutate(id)}
        onSelectHost={(id) => {
          // Host pad = Scan / manage for that node. Server crates open the inspector.
          clearMapSelection();
          setScanNodeId(id);
        }}
        onBackgroundClick={clearMapSelection}
        onSelectedAnchorChange={setSelectedAnchor}
        showAddButton={!dockOpen && !addNodeOpen && !scanNodeId}
      />

      {consoleOpen && selectedId && selected ? (
        <ServerConsoleBubble
          serverId={selectedId}
          serverName={selected.name}
          anchor={selectedAnchor}
          detail={detail.data}
        />
      ) : null}

      {addNodeOpen ? (
        <div className="map-add-node-overlay map-add-node-overlay-start">
          <MapAddNodePanel onClose={() => setAddNodeOpen(false)} />
        </div>
      ) : null}

      {scanNodeId ? (
        <div className="map-add-node-overlay map-add-node-overlay-start">
          <MapManageSuggestPanel
            nodeId={scanNodeId}
            nodeName={
              (nodes.data?.nodes ?? []).find((n) => n.id === scanNodeId)?.name ?? scanNodeId
            }
            onClose={() => setScanNodeId(null)}
          />
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
                  <button
                    type="button"
                    className={consoleOpen ? "linkish active" : "linkish"}
                    aria-pressed={consoleOpen}
                    onClick={() => setConsoleOpen((v) => !v)}
                  >
                    Terminal
                  </button>
                ) : null}
                {selectedId ? (
                  <button type="button" className="linkish" onClick={openInstallChat}>
                    + Add
                  </button>
                ) : null}
                <button
                  type="button"
                  className="linkish"
                  onClick={() => clearMapSelection()}
                >
                  Close
                </button>
              </div>
            </div>
            <p className="canvas-dock-hint">{dockHint}</p>
            <ChatChannelList
              channels={channelItems}
              activeKey={activeKey}
              onSelect={selectChannel}
            />
            {sessionError ? <p className="error">{sessionError}</p> : null}
            {opsError ? (
              <p className="error" role="alert">
                {runtimeErrorHint(opsError) ?? opsError}
              </p>
            ) : null}
            {servers.isError ? (
              <p className="error">{(servers.error as Error).message}</p>
            ) : null}
            {selected && selectedId ? (
              <>
                <div className="canvas-status-row">
                  <span className={`server-status-pill status-${status}`}>{statusLabel(status)}</span>
                  {selected.game ? <span className="muted">{selected.game}</span> : null}
                  {formatServerUsage(selected) ? (
                    <span className="muted">{formatServerUsage(selected)}</span>
                  ) : null}
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
                  disabled={opsBusy || processStatus === "running" || processStatus === "starting"}
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
                <strong>{unbound ? "Describe what to install" : "Ask the agent"}</strong>
                <p className="muted status-inline">{emptyHint}</p>
              </div>
            ) : (
              lines.map((line, i) => {
                const streaming =
                  chatPending && line.role === "assistant" && i === lines.length - 1;
                return (
                  <div
                    key={i}
                    className={`msg ${line.role}${streaming ? " streaming" : ""}`}
                  >
                    <span className="meta">{line.role === "user" ? "You" : "Agent"}</span>
                    {line.role === "assistant" ? (
                      <ChatMarkdown content={line.content} />
                    ) : (
                      line.content
                    )}
                    {streaming ? <span className="stream-caret" aria-hidden /> : null}
                    {line.tools?.length ? (
                      <details className="tool-trace">
                        <summary>Steps ({line.tools.length})</summary>
                        <ul className="list compact-list">
                          {line.tools.map((tool, ti) => (
                            <li key={`${tool.name}-${ti}`}>{nowLineForTool(tool.name)}</li>
                          ))}
                        </ul>
                      </details>
                    ) : null}
                    {line.degradedMode ? (
                      <p className="degraded-mode-note" role="status">
                        This model did not use tools. Manual Start/Stop and MCP still work.
                      </p>
                    ) : null}
                  </div>
                );
              })
            )}
            <ChatNowLine view={nowView} />
          </div>

          <form className="stack canvas-chat-composer" onSubmit={onSubmit}>
            <label className="field">
              <span className="sr-only">Message</span>
              <textarea
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                onKeyDown={onComposerKeyDown}
                placeholder={
                  unbound ? "Describe the server you want…" : "Ask the agent what you need…"
                }
                disabled={chatPending}
                rows={2}
                aria-label="Message the agents"
              />
            </label>
            <div className="btn-row">
              {chatPending ? (
                <button
                  type="button"
                  className="btn btn-ghost btn-danger"
                  onClick={stopChat}
                  aria-label="Stop agent response"
                >
                  Stop
                </button>
              ) : (
                <button
                  type="submit"
                  className="btn btn-primary"
                  disabled={!message.trim()}
                >
                  Send
                </button>
              )}
              <span className="muted canvas-busy-hint">
                {chatPending
                  ? "Stop cancels this turn"
                  : "Enter to send · Shift+Enter for line"}
              </span>
            </div>
            {chatSendError ? <p className="error">{chatSendError}</p> : null}
          </form>
        </aside>
      ) : null}
    </div>
  );
}
