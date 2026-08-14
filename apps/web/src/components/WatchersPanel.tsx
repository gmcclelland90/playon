import { useEffect, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { can, type PublicUser } from "@playon/shared";
import { api, type WatcherRow } from "../api";
import { playonSocket } from "../ws";

function triggerSummary(w: WatcherRow): string {
  const t = w.trigger;
  switch (t.kind) {
    case "schedule":
      return `every ${Math.round(Number(t.intervalMs) / 1000)}s` + (t.cron ? ` · cron ${t.cron}` : "");
    case "server_status":
      return `status ${(t.statuses as string[] | undefined)?.join("|") ?? "?"}`;
    case "log_pattern":
      return `log /${t.pattern}/`;
    case "health":
      return "health fail";
    case "query":
      return `query ${t.predicate} ${t.value}`;
    case "panel_input":
      return `panel ${t.inputType}`;
    default:
      return t.kind;
  }
}

function actionSummary(w: WatcherRow): string {
  if (w.action.kind === "tools") {
    const steps = w.action.steps as Array<{ tool: string }> | undefined;
    return `tools: ${(steps ?? []).map((s) => s.tool).join(", ") || "—"}`;
  }
  if (w.action.kind === "agent") return "agent prompt";
  return w.action.kind;
}

export function WatchersPanel({
  user,
  serverId,
  serverOptions,
}: {
  user: PublicUser;
  /** When set, list only this server and default create to it. */
  serverId?: string;
  serverOptions?: Array<{ id: string; name: string }>;
}) {
  const qc = useQueryClient();
  const canManage = can(user.role, "watchers.manage");
  const canRead = can(user.role, "watchers.read");
  const [showCreate, setShowCreate] = useState(false);
  const [name, setName] = useState("");
  const [createServerId, setCreateServerId] = useState(serverId ?? "");
  const [intervalSec, setIntervalSec] = useState("300");
  const [prompt, setPrompt] = useState("Check health and remediate if safe.");
  const [actionKind, setActionKind] = useState<"agent" | "health_tools">("health_tools");

  const watchers = useQuery({
    queryKey: ["watchers", serverId ?? "all"],
    queryFn: () => api.watchers(serverId),
    enabled: canRead,
    refetchInterval: 15_000,
  });

  useEffect(() => {
    if (!canRead) return;
    playonSocket.connect();
    return playonSocket.subscribe((ev) => {
      if (ev.type === "watcher.run" || ev.type === "watcher.fired") {
        void qc.invalidateQueries({ queryKey: ["watchers"] });
      }
    });
  }, [canRead, qc]);

  useEffect(() => {
    if (serverId) setCreateServerId(serverId);
  }, [serverId]);

  const toggle = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      api.updateWatcher(id, { enabled }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["watchers"] });
    },
  });

  const runNow = useMutation({
    mutationFn: (id: string) => api.runWatcher(id),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["watchers"] });
    },
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.deleteWatcher(id),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["watchers"] });
    },
  });

  const create = useMutation({
    mutationFn: () => {
      const sid = createServerId || serverId;
      if (!sid) throw new Error("server_required");
      const intervalMs = Math.max(10, Number(intervalSec) || 300) * 1000;
      if (actionKind === "health_tools") {
        return api.createWatcher({
          serverId: sid,
          name: name.trim() || "Health check",
          enabled: true,
          cooldownMs: intervalMs,
          trigger: { kind: "schedule", intervalMs },
          action: {
            kind: "tools",
            steps: [{ tool: "servers_health_check", args: { remediate: true } }],
          },
        });
      }
      return api.createWatcher({
        serverId: sid,
        name: name.trim() || "Monitor agent",
        enabled: true,
        cooldownMs: intervalMs,
        trigger: { kind: "schedule", intervalMs },
        action: { kind: "agent", prompt: prompt.trim(), includeContext: true },
      });
    },
    onSuccess: async () => {
      setShowCreate(false);
      setName("");
      await qc.invalidateQueries({ queryKey: ["watchers"] });
    },
  });

  if (!canRead) return null;

  const list = watchers.data?.watchers ?? [];

  function onCreate(e: FormEvent) {
    e.preventDefault();
    create.mutate();
  }

  return (
    <section className="panel stack">
      <div className="dash-section-head">
        <h3>Watchers</h3>
        {canManage ? (
          <button
            type="button"
            className="btn btn-ghost btn-compact"
            onClick={() => setShowCreate((v) => !v)}
          >
            {showCreate ? "Cancel" : "Add"}
          </button>
        ) : null}
      </div>
      <p className="muted status-inline">
        Schedules and hooks that run tool scripts or a Monitor agent turn.
      </p>

      {showCreate && canManage ? (
        <form className="stack tight" onSubmit={onCreate}>
          {!serverId && serverOptions?.length ? (
            <label className="stack tight">
              <span className="muted">Server</span>
              <select
                value={createServerId}
                onChange={(e) => setCreateServerId(e.target.value)}
                required
              >
                <option value="">Select…</option>
                {serverOptions.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          <label className="stack tight">
            <span className="muted">Name</span>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Health restart" />
          </label>
          <label className="stack tight">
            <span className="muted">Interval (seconds)</span>
            <input
              type="number"
              min={10}
              value={intervalSec}
              onChange={(e) => setIntervalSec(e.target.value)}
            />
          </label>
          <label className="stack tight">
            <span className="muted">Action</span>
            <select
              value={actionKind}
              onChange={(e) => setActionKind(e.target.value as "agent" | "health_tools")}
            >
              <option value="health_tools">Health check + remediate</option>
              <option value="agent">Monitor agent prompt</option>
            </select>
          </label>
          {actionKind === "agent" ? (
            <label className="stack tight">
              <span className="muted">Prompt</span>
              <textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={3} />
            </label>
          ) : null}
          <button type="submit" className="btn" disabled={create.isPending}>
            {create.isPending ? "Creating…" : "Create watcher"}
          </button>
          {create.isError ? (
            <p className="error">{(create.error as Error).message}</p>
          ) : null}
        </form>
      ) : null}

      {watchers.isLoading ? (
        <div className="skeleton" aria-hidden>
          <div className="skeleton-row" />
        </div>
      ) : watchers.isError ? (
        <p className="error" role="alert">
          {(watchers.error as Error).message}
        </p>
      ) : list.length ? (
        <ul className="list compact-list">
          {list.map((w) => (
            <li key={w.id}>
              <div>
                <strong>{w.name}</strong>
                <div className="muted">
                  {w.enabled ? "on" : "off"} · {triggerSummary(w)} · {actionSummary(w)}
                  {w.source === "skill_template"
                    ? " · from skill"
                    : w.source === "platform"
                      ? " · platform"
                      : ""}
                  {w.lastFiredAt
                    ? ` · last ${new Date(w.lastFiredAt).toLocaleString()}`
                    : ""}
                </div>
              </div>
              {canManage ? (
                <div className="btn-row">
                  <button
                    type="button"
                    className="btn btn-ghost btn-compact"
                    disabled={toggle.isPending}
                    onClick={() => toggle.mutate({ id: w.id, enabled: !w.enabled })}
                  >
                    {w.enabled ? "Disable" : "Enable"}
                  </button>
                  <button
                    type="button"
                    className="btn btn-ghost btn-compact"
                    disabled={runNow.isPending}
                    onClick={() => runNow.mutate(w.id)}
                  >
                    Run
                  </button>
                  <button
                    type="button"
                    className="btn btn-ghost btn-compact"
                    disabled={remove.isPending}
                    onClick={() => {
                      if (window.confirm(`Delete watcher “${w.name}”?`)) remove.mutate(w.id);
                    }}
                  >
                    Delete
                  </button>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      ) : (
        <div className="empty-hint">
          <strong>No watchers</strong>
          <p className="muted status-inline">
            Add a schedule or enable skill templates after creating a server.
          </p>
        </div>
      )}
    </section>
  );
}
