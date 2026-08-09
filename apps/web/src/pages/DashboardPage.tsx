import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { can, type PublicUser } from "@playon/shared";
import { api } from "../api";
import {
  nodePresenceHint,
  nodePresenceLabel,
  runtimeErrorHint,
  shortDisplayName,
  statusLabel,
} from "../status";

function toolLabel(name: string): string {
  const map: Record<string, string> = {
    fs_write: "Wrote a file",
    fs_read: "Read a file",
    fs_list: "Listed files",
    fs_delete: "Deleted a file",
    servers_start: "Started a server",
    servers_stop: "Stopped a server",
    servers_restart: "Restarted a server",
    servers_health_check: "Checked server health",
    snapshot_create: "Took a snapshot",
    snapshot_restore: "Restored a snapshot",
    rcon_exec: "Ran a console command",
    rcon_say: "Sent an in-game message",
  };
  return map[name] ?? name.replace(/_/g, " ");
}

function activityServerId(args: unknown): string | null {
  if (!args || typeof args !== "object") return null;
  const id = (args as { serverId?: unknown }).serverId;
  return typeof id === "string" && id.trim() ? id : null;
}

function openServerOnMap(serverId: string) {
  try {
    localStorage.setItem("playon.lastServerId", serverId);
  } catch {
    /* ignore */
  }
}

function formatBytes(bytes: number | null | undefined): string {
  if (bytes == null || !Number.isFinite(bytes)) return "—";
  const gib = bytes / 1024 ** 3;
  if (gib >= 1) return `${gib.toFixed(1)} GiB`;
  const mib = bytes / 1024 ** 2;
  return `${mib.toFixed(0)} MiB`;
}

function relativeTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "just now";
  const mins = Math.floor(ms / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export function DashboardPage({ user }: { user: PublicUser }) {
  const qc = useQueryClient();
  const canRestore = can(user.role, "snapshots.restore");
  const canMap = can(user.role, "chat.agent");
  const confirmCancelRef = useRef<HTMLButtonElement>(null);
  const [pendingRestore, setPendingRestore] = useState<
    | { kind: "snapshot"; id: string; label: string; serverLabel: string }
    | { kind: "offnode"; id: string; label: string }
    | null
  >(null);
  const [pendingStop, setPendingStop] = useState<{ id: string; label: string } | null>(null);

  useEffect(() => {
    if (!pendingRestore && !pendingStop) return;
    confirmCancelRef.current?.focus();
  }, [pendingRestore, pendingStop]);
  const [opsNotice, setOpsNotice] = useState<string | null>(null);

  function flashOpsNotice(message: string) {
    setOpsNotice(message);
    window.setTimeout(() => setOpsNotice(null), 4000);
  }

  const servers = useQuery({ queryKey: ["servers"], queryFn: api.servers, refetchInterval: 5000 });
  const nodes = useQuery({ queryKey: ["nodes"], queryFn: api.nodes, refetchInterval: 10_000 });
  const updates = useQuery({
    queryKey: ["updates"],
    queryFn: () => api.updatesStatus(false),
    enabled: can(user.role, "settings.llm"),
    refetchInterval: 60_000,
  });
  const snapshots = useQuery({
    queryKey: ["snapshots"],
    queryFn: () => api.snapshots(),
    refetchInterval: 15_000,
  });
  const offnode = useQuery({
    queryKey: ["offnode-backups"],
    queryFn: () => api.offnodeBackups(),
    refetchInterval: 20_000,
  });
  const backupTarget = useQuery({ queryKey: ["backup-target"], queryFn: api.backupTarget });
  const activity = useQuery({
    queryKey: ["activity"],
    queryFn: () => api.activity(20),
    refetchInterval: 8_000,
  });

  const serverList = servers.data?.servers ?? [];
  const running = serverList.filter((s) => s.status === "running").length;
  const stopped = serverList.filter((s) => s.status === "stopped").length;
  const errored = serverList.filter((s) => s.status === "error").length;
  const serverName = (id: string) => serverList.find((s) => s.id === id)?.name ?? id.slice(0, 8);

  const startServer = useMutation({
    mutationFn: (id: string) => api.startServer(id),
    onSuccess: async (_data, id) => {
      flashOpsNotice(`Starting ${serverName(id)}… status will update below.`);
      await qc.invalidateQueries({ queryKey: ["servers"] });
    },
  });
  const stopServer = useMutation({
    mutationFn: (id: string) => api.stopServer(id),
    onSuccess: async (_data, id) => {
      flashOpsNotice(`Stopping ${serverName(id)}… status will update below.`);
      await qc.invalidateQueries({ queryKey: ["servers"] });
    },
  });
  const createSnap = useMutation({
    mutationFn: (serverId: string) => api.createSnapshot({ serverId, label: "manual" }),
    onSuccess: async (_data, serverId) => {
      flashOpsNotice(`Snapshot started for ${serverName(serverId)}.`);
      await qc.invalidateQueries({ queryKey: ["snapshots"] });
    },
  });

  const restoreSnap = useMutation({
    mutationFn: (id: string) => api.restoreSnapshot(id),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["snapshots"] });
      await qc.invalidateQueries({ queryKey: ["servers"] });
    },
  });

  const offnodeBackup = useMutation({
    mutationFn: (serverId: string) => api.createOffnodeBackup({ serverId }),
    onSuccess: async () => {
      flashOpsNotice("USB/NAS copy started");
      await qc.invalidateQueries({ queryKey: ["offnode-backups"] });
      await qc.invalidateQueries({ queryKey: ["snapshots"] });
    },
  });

  const restoreOffnode = useMutation({
    mutationFn: (id: string) => api.restoreOffnodeBackup(id),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["offnode-backups"] });
      await qc.invalidateQueries({ queryKey: ["servers"] });
    },
  });

  return (
    <div className="pane dashboard dashboard-page">
      <div className="stack">
        <header className="page-header">
          <h2>Dashboard</h2>
          <p className="lede">Tonight&apos;s host view — what&apos;s live, what to restore, what failed.</p>
        </header>

        <p className="dash-summary" aria-live="polite">
          {servers.isLoading ? (
            <span>Loading servers…</span>
          ) : servers.isError ? (
            <span className="error">Couldn’t load servers.</span>
          ) : (
            <>
              <strong>{running}</strong> running · <strong>{stopped}</strong> stopped
              {errored ? (
                <>
                  {" "}
                  · <strong>{errored}</strong> failed
                </>
              ) : null}
              {" · "}
              <strong>{nodes.data?.nodes?.length ?? 0}</strong> nodes
            </>
          )}
        </p>

        {opsNotice ? (
          <p className="ok dash-ops-notice" role="status" aria-live="polite">
            {opsNotice}
          </p>
        ) : null}

        {pendingStop ? (
          <div
            className="confirm-banner panel stack"
            role="alertdialog"
            aria-label="Confirm stop"
            onKeyDown={(e) => {
              if (e.key === "Escape" && !stopServer.isPending) {
                e.preventDefault();
                setPendingStop(null);
              }
            }}
          >
            <p className="status-inline">
              Stop <strong>{pendingStop.label}</strong>? Players on that pad will be kicked.
            </p>
            <div className="btn-row">
              <button
                type="button"
                className="btn btn-danger"
                disabled={stopServer.isPending}
                onClick={() => {
                  stopServer.mutate(pendingStop.id, {
                    onSuccess: () => setPendingStop(null),
                  });
                }}
              >
                {stopServer.isPending ? "Stopping…" : "Stop server"}
              </button>
              <button
                type="button"
                className="btn btn-ghost"
                ref={confirmCancelRef}
                disabled={stopServer.isPending}
                onClick={() => setPendingStop(null)}
              >
                Cancel
              </button>
            </div>
          </div>
        ) : null}

        {pendingRestore ? (
          <div
            className="confirm-banner panel stack"
            role="alertdialog"
            aria-label="Confirm restore"
            onKeyDown={(e) => {
              if (e.key === "Escape" && !restoreSnap.isPending && !restoreOffnode.isPending) {
                e.preventDefault();
                setPendingRestore(null);
              }
            }}
          >
            <p className="status-inline">
              {pendingRestore.kind === "snapshot"
                ? `Restore snapshot “${pendingRestore.label}” onto ${pendingRestore.serverLabel}?`
                : `Restore USB/NAS backup “${pendingRestore.label}”?`}
            </p>
            <div className="btn-row">
              <button
                type="button"
                className="btn btn-primary"
                disabled={restoreSnap.isPending || restoreOffnode.isPending}
                onClick={() => {
                  if (pendingRestore.kind === "snapshot") {
                    restoreSnap.mutate(pendingRestore.id, {
                      onSuccess: () => setPendingRestore(null),
                    });
                  } else {
                    restoreOffnode.mutate(pendingRestore.id, {
                      onSuccess: () => setPendingRestore(null),
                    });
                  }
                }}
              >
                {restoreSnap.isPending || restoreOffnode.isPending ? "Restoring…" : "Restore"}
              </button>
              <button
                type="button"
                className="btn btn-ghost"
                ref={confirmCancelRef}
                disabled={restoreSnap.isPending || restoreOffnode.isPending}
                onClick={() => setPendingRestore(null)}
              >
                Cancel
              </button>
            </div>
            {restoreSnap.isError ? (
              <p className="error">{(restoreSnap.error as Error).message}</p>
            ) : null}
            {restoreOffnode.isError ? (
              <p className="error">{(restoreOffnode.error as Error).message}</p>
            ) : null}
          </div>
        ) : null}

        <div className="dash-grid">
          <section className="panel stack dash-primary">
            <div className="dash-section-head">
              <h3>Servers</h3>
              {canMap ? (
                <Link className="linkish" to="/" title="Conversation-first map">
                  Map
                </Link>
              ) : null}
            </div>
            {servers.isLoading ? (
              <div className="skeleton" aria-hidden>
                <div className="skeleton-row" />
              </div>
            ) : servers.isError ? (
              <p className="error" role="alert">
                {(servers.error as Error).message || "Couldn’t load servers."}
              </p>
            ) : serverList.length ? (
              <ul className="list compact-list">
                {serverList.map((s) => (
                  <li key={s.id}>
                    <div>
                      <strong title={s.name}>{shortDisplayName(s.name, 28)}</strong>
                      <div className="muted canvas-status-row">
                        <span className={`server-status-pill status-${s.status}`}>
                          {statusLabel(s.status)}
                        </span>
                        <span title={s.runtimeMode ? `${s.game ?? ""} · ${s.runtimeMode}` : s.game ?? undefined}>
                          {s.game ?? "—"}
                        </span>
                      </div>
                    </div>
                    <div className="btn-row">
                      {canMap ? (
                        <Link
                          className="btn btn-ghost btn-compact"
                          to="/"
                          onClick={() => openServerOnMap(s.id)}
                          title={`Open ${s.name} on the map`}
                        >
                          On map
                        </Link>
                      ) : null}
                      {s.status === "running" || s.status === "starting" ? (
                        <button
                          type="button"
                          className="btn btn-ghost btn-compact"
                          disabled={stopServer.isPending}
                          onClick={() =>
                            setPendingStop({
                              id: s.id,
                              label: shortDisplayName(s.name, 28),
                            })
                          }
                        >
                          Stop
                        </button>
                      ) : (
                        <button
                          type="button"
                          className="btn btn-primary btn-compact"
                          disabled={startServer.isPending}
                          onClick={() => startServer.mutate(s.id)}
                        >
                          Start
                        </button>
                      )}
                      <button
                        type="button"
                        className="btn btn-ghost btn-compact dash-secondary-action"
                        disabled={createSnap.isPending}
                        onClick={() => createSnap.mutate(s.id)}
                        title="Save a restore point"
                      >
                        Snapshot
                      </button>
                      {backupTarget.data?.target ? (
                        <button
                          type="button"
                          className="btn btn-ghost btn-compact dash-secondary-action"
                          disabled={offnodeBackup.isPending}
                          onClick={() => offnodeBackup.mutate(s.id)}
                        >
                          USB/NAS
                        </button>
                      ) : null}
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <div className="empty-hint">
                <strong>No servers</strong>
                <p className="muted status-inline">
                  {canMap ? (
                    <>
                      Describe a server on the <Link to="/">Map</Link> — agents will install it.
                    </>
                  ) : (
                    <>Ask an Owner to stand up a server on the Map.</>
                  )}
                </p>
              </div>
            )}
            {startServer.isError ? (
              <p className="error" role="alert">
                {runtimeErrorHint((startServer.error as Error).message) ??
                  (startServer.error as Error).message}
              </p>
            ) : null}
            {stopServer.isError ? (
              <p className="error" role="alert">
                {runtimeErrorHint((stopServer.error as Error).message) ??
                  (stopServer.error as Error).message}
              </p>
            ) : null}
            {createSnap.isError ? (
              <p className="error">{(createSnap.error as Error).message}</p>
            ) : null}
            {offnodeBackup.isError ? (
              <p className="error">{(offnodeBackup.error as Error).message}</p>
            ) : null}
          </section>

          <div className="dash-secondary">
          <section className="panel stack">
            <div className="dash-section-head">
              <h3>Nodes</h3>
            </div>
            {nodes.isLoading ? (
              <div className="skeleton" aria-hidden>
                <div className="skeleton-row" />
              </div>
            ) : nodes.isError ? (
              <p className="error" role="alert">
                {(nodes.error as Error).message || "Couldn’t load nodes."}
              </p>
            ) : nodes.data?.nodes?.length ? (
              <ul className="list compact-list">
                {nodes.data.nodes.map((n) => {
                  const presenceHint = nodePresenceHint({
                    id: n.id,
                    status: n.status,
                    agentVersion: n.agentVersion,
                  });
                  const caps = [
                    n.os,
                    n.docker ? "Docker" : null,
                    n.native !== false ? "native" : null,
                    n.steamcmd ? "SteamCMD" : null,
                    n.tunnelStatus && n.tunnelStatus !== "none"
                      ? `tunnel ${n.tunnelStatus}`
                      : null,
                    n.agentVersion ? `v${n.agentVersion}` : null,
                    n.id !== "local" &&
                    updates.data?.nodes?.some((u) => u.nodeId === n.id && u.updateAvailable)
                      ? "update available"
                      : null,
                  ].filter(Boolean);
                  return (
                  <li key={n.id}>
                    <div>
                      <strong>{n.name}</strong>{" "}
                      {(() => {
                        const tag = n.badge ?? n.placement ?? n.kind ?? "";
                        if (!tag) return null;
                        const lower = tag.toLowerCase();
                        if (lower === "local" || lower.includes(n.name.toLowerCase())) {
                          return lower === "local" ? (
                            <span className="muted">Local</span>
                          ) : null;
                        }
                        return <span className="muted">{tag}</span>;
                      })()}
                      <div className="muted canvas-status-row">
                        <span
                          className={`node-status node-${
                            n.agentVersion === "pending" && n.status !== "online"
                              ? "offline"
                              : n.status
                          }`}
                        >
                          {nodePresenceLabel({
                            status: n.status,
                            agentVersion: n.agentVersion,
                          })}
                        </span>
                        <span>{formatBytes(n.freeDiskBytes)} free</span>
                        <span>Seen {relativeTime(String(n.lastSeenAt))}</span>
                      </div>
                      {presenceHint ? (
                        <p className="muted status-inline">{presenceHint}</p>
                      ) : null}
                      {caps.length ? (
                        <details className="dash-node-caps">
                          <summary className="muted small">Host details</summary>
                          <p className="muted small status-inline">{caps.join(" · ")}</p>
                        </details>
                      ) : null}
                    </div>
                  </li>
                  );
                })}
              </ul>
            ) : (
              <div className="empty-hint">
                <strong>Local host only</strong>
                <p className="muted status-inline">
                  Add a LAN or cloud machine from Settings → Nodes, or wait for the local node to
                  register.
                </p>
              </div>
            )}
          </section>

          <section className="panel stack">
            <div className="dash-section-head">
              <h3>Backups</h3>
            </div>
            {snapshots.isLoading ? (
              <div className="skeleton" aria-hidden>
                <div className="skeleton-row" />
              </div>
            ) : snapshots.data?.snapshots?.length ? (
              <ul className="list compact-list">
                {snapshots.data.snapshots.slice(0, 5).map((snap) => (
                  <li key={snap.id}>
                    <div>
                      <strong title={snap.label}>
                        {shortDisplayName(snap.label, 32)}
                      </strong>
                      <div className="muted">
                        {shortDisplayName(serverName(snap.serverId), 22)} ·{" "}
                        {relativeTime(snap.createdAt)}
                      </div>
                    </div>
                    {canRestore ? (
                      <button
                        type="button"
                        className="btn btn-ghost btn-compact"
                        disabled={restoreSnap.isPending}
                        onClick={() =>
                          setPendingRestore({
                            kind: "snapshot",
                            id: snap.id,
                            label: snap.label,
                            serverLabel: serverName(snap.serverId),
                          })
                        }
                      >
                        Restore
                      </button>
                    ) : null}
                  </li>
                ))}
              </ul>
            ) : (
              <div className="empty-hint">
                <strong>No snapshots yet</strong>
                <p className="muted status-inline">
                  Snapshot a server above, or let scheduled retention create them.
                </p>
              </div>
            )}
            {!pendingRestore && restoreSnap.isError ? (
              <p className="error">{(restoreSnap.error as Error).message}</p>
            ) : null}

            <h4 className="section-subhead">USB/NAS</h4>
            {backupTarget.data?.target ? (
              <p className="muted status-inline">
                Target: <code>{backupTarget.data.target.rootPath}</code>
              </p>
            ) : (
              <p className="muted status-inline">
                Set a backup root in Settings to enable external copies.
              </p>
            )}
            {offnode.data?.backups?.length ? (
              <ul className="list compact-list">
                {offnode.data.backups.slice(0, 8).map((b) => (
                  <li key={b.id}>
                    <div>
                      <strong>{b.label}</strong>
                      <div className="muted">
                        {serverName(b.serverId)} · {relativeTime(b.exportedAt)}
                      </div>
                    </div>
                    {canRestore ? (
                      <button
                        type="button"
                        className="btn btn-ghost btn-compact"
                        disabled={restoreOffnode.isPending}
                        onClick={() =>
                          setPendingRestore({
                            kind: "offnode",
                            id: b.id,
                            label: b.label,
                          })
                        }
                      >
                        Restore
                      </button>
                    ) : null}
                  </li>
                ))}
              </ul>
            ) : null}
            {!pendingRestore && restoreOffnode.isError ? (
              <p className="error">{(restoreOffnode.error as Error).message}</p>
            ) : null}
          </section>

          <div className="dash-quiet">
            <section className="panel stack">
              <div className="dash-section-head">
                <h3>Recent activity</h3>
                {can(user.role, "watchers.read") ? (
                  <Link
                    className="linkish"
                    to="/settings#watchers"
                    title="Scheduled health checks and automations"
                  >
                    Scheduled checks
                  </Link>
                ) : null}
              </div>
              {activity.isLoading ? (
                <div className="skeleton" aria-hidden>
                  <div className="skeleton-row" />
                  <div className="skeleton-row" />
                </div>
              ) : activity.data?.activity?.length ? (
                (() => {
                  const now = Date.now();
                  const recentCutoff = now - 24 * 60 * 60_000;
                  const failCutoff = now - 12 * 60 * 60_000;
                  const shown = activity.data.activity
                    .filter((item) => {
                      const t = new Date(item.createdAt).getTime();
                      const failed = item.status === "failed" || item.status === "error";
                      if (failed) return t >= failCutoff;
                      return t >= recentCutoff;
                    })
                    .slice(0, 8);
                  if (!shown.length) {
                    return (
                      <div className="empty-hint">
                        <strong>Quiet night</strong>
                        <p className="muted status-inline">
                          No agent moves in the last day. Map chat will show up here.
                        </p>
                      </div>
                    );
                  }
                  return (
                    <ul className="activity-feed">
                      {shown.map((item) => {
                        const failed = item.status === "failed" || item.status === "error";
                        const sid = activityServerId(item.args);
                        const label = sid ? serverName(sid) : null;
                        return (
                          <li key={item.id}>
                            <span className="activity-tool">{toolLabel(item.toolName)}</span>
                            {label ? <span className="muted">{label}</span> : null}
                            <span className={`activity-status status-${item.status}`}>
                              {statusLabel(item.status)}
                            </span>
                            <span className="muted">{relativeTime(item.createdAt)}</span>
                            {failed && canMap ? (
                              <Link
                                className="linkish"
                                to="/"
                                title="Open map to investigate"
                                onClick={() => {
                                  if (sid) openServerOnMap(sid);
                                }}
                              >
                                On map
                              </Link>
                            ) : null}
                          </li>
                        );
                      })}
                    </ul>
                  );
                })()
              ) : (
                <div className="empty-hint">
                  <strong>Quiet so far</strong>
                  <p className="muted status-inline">
                    Recent agent tool calls from Map chat show up here.
                  </p>
                </div>
              )}
            </section>
          </div>
          </div>
        </div>
      </div>
    </div>
  );
}
