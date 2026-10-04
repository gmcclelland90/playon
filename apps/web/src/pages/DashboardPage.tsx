import { useEffect, useRef, useState, type CSSProperties } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { can, type PublicUser } from "@playon/shared";
import { api } from "../api";
import { ServerNameControl } from "../components/ServerNameControl";
import { HostUsageMeters, ServerUsageMeters } from "../components/UsageMeters";
import { gameBadgeText, gameHue } from "../game-badge";
import {
  nodePresenceHint,
  nodePresenceLabel,
  runtimeErrorHint,
  shortDisplayName,
  displayServerStatus,
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
    servers_rename: "Renamed a server",
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

type AttentionItem = { key: string; tone: "warn" | "danger"; text: string; serverId?: string };

export function DashboardPage({ user }: { user: PublicUser }) {
  const qc = useQueryClient();
  const canRestore = can(user.role, "snapshots.restore");
  const canMap = can(user.role, "chat.agent");
  const canRename = can(user.role, "servers.manage");
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
  const running = serverList.filter((s) => displayServerStatus(s.status, s.ready) === "running").length;
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
  const renameServer = useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) => api.renameServer(id, name),
    onSuccess: async () => {
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

  const nodeList = nodes.data?.nodes ?? [];
  const nodeName = (id?: string | null) =>
    id ? nodeList.find((n) => n.id === id)?.name ?? null : null;
  const serversOnNode = (id: string) => serverList.filter((s) => s.nodeId === id).length;
  const hostState = (n: (typeof nodeList)[number]) =>
    n.agentVersion === "pending" && n.status !== "online" ? "offline" : n.status;
  const hostsOnline = nodeList.filter((n) => n.status === "online").length;

  // Host load alerts already get one Home line from ResourceAlertBanner; only
  // surface what that banner doesn't: broken servers and hosts that went dark.
  const attention: AttentionItem[] = [
    ...serverList.flatMap((s): AttentionItem[] => {
      const st = displayServerStatus(s.status, s.ready);
      if (st === "error" || st === "failed") {
        return [{ key: `s-${s.id}`, tone: "danger", text: `${shortDisplayName(s.name, 28)} failed`, serverId: s.id }];
      }
      if (st === "degraded") {
        return [{ key: `s-${s.id}`, tone: "warn", text: `${shortDisplayName(s.name, 28)} is up but not joinable`, serverId: s.id }];
      }
      return [];
    }),
    ...nodeList.flatMap((n): AttentionItem[] => {
      if (n.agentVersion === "pending") return [];
      if (n.status === "offline") {
        return [{ key: `n-${n.id}`, tone: "danger", text: `${n.name} is offline` }];
      }
      if (n.status === "stale") {
        return [{ key: `n-${n.id}`, tone: "warn", text: `${n.name} stopped reporting` }];
      }
      return [];
    }),
  ];

  return (
    <div className="pane dashboard dashboard-page">
      <div className="stack dash-stack">
        <header className="dash-head">
          <div className="page-header">
            <h2>Dashboard</h2>
            <p className="lede">Tonight&apos;s host view — what&apos;s live, what to restore, what failed.</p>
          </div>
          <p className="dash-pulse" aria-live="polite">
            {servers.isLoading ? (
              <span className="muted">Loading servers…</span>
            ) : servers.isError ? (
              <span className="error">Couldn’t load servers.</span>
            ) : (
              <>
                <span className={`dash-pulse-live${running ? " is-live" : ""}`}>
                  <span className="dash-dot" aria-hidden />
                  <strong>{running}</strong> live
                </span>
                <span>
                  <strong>{stopped}</strong> stopped
                </span>
                {errored ? (
                  <span className="dash-pulse-bad">
                    <strong>{errored}</strong> failed
                  </span>
                ) : null}
                <span>
                  <strong>
                    {hostsOnline}/{nodeList.length}
                  </strong>{" "}
                  hosts online
                </span>
              </>
            )}
          </p>
        </header>

        {attention.length ? (
          <ul className="dash-attention" aria-label="Needs attention">
            {attention.map((a) => (
              <li key={a.key} className={`tone-${a.tone}`}>
                <span className="dash-dot" aria-hidden />
                <span>{a.text}</span>
                {a.serverId && canMap ? (
                  <Link
                    className="linkish"
                    to="/"
                    onClick={() => openServerOnMap(a.serverId!)}
                  >
                    On map
                  </Link>
                ) : null}
              </li>
            ))}
          </ul>
        ) : null}


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

        <div className="dash-layout">
          <div className="dash-main">
            <section className="panel dash-section" aria-labelledby="dash-servers-h">
              <div className="dash-section-head">
                <h3 id="dash-servers-h">
                  Servers {serverList.length ? <span className="dash-count">{serverList.length}</span> : null}
                </h3>
                {canMap ? (
                  <Link className="linkish" to="/" title="Conversation-first map">
                    Open map
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
                <ul className="dash-rows">
                  {serverList.map((s) => {
                    const st = displayServerStatus(s.status, s.ready);
                    const live = s.status === "running" || s.status === "starting";
                    const host = nodeName(s.nodeId);
                    return (
                      <li
                        key={s.id}
                        className={`dash-row state-${st}${live ? "" : " is-idle"}`}
                        data-game={s.game ?? undefined}
                      >
                        <div className="dash-row-id">
                          <span
                            className="dash-game-badge"
                            style={{ "--game-h": gameHue(s.game) } as CSSProperties}
                            aria-hidden
                          >
                            {gameBadgeText(s.game)}
                            <span className={`dash-dot state-${st}`} />
                          </span>
                          <div className="dash-row-text">
                            {canRename ? (
                              <ServerNameControl
                                name={s.name}
                                as="strong"
                                pending={renameServer.isPending}
                                error={
                                  renameServer.isError && renameServer.variables?.id === s.id
                                    ? (renameServer.error as Error).message
                                    : null
                                }
                                onSave={(name) => renameServer.mutateAsync({ id: s.id, name })}
                              />
                            ) : (
                              <strong title={s.name}>{shortDisplayName(s.name, 28)}</strong>
                            )}
                            <p className="dash-row-meta">
                              <span className={`dash-state state-${st}`}>{statusLabel(st)}</span>
                              <span title={s.runtimeMode ? `${s.game ?? ""} · ${s.runtimeMode}` : s.game ?? undefined}>
                                {s.game ?? "—"}
                              </span>
                              {host ? <span>{host}</span> : null}
                            </p>
                          </div>
                        </div>
                        <div className="dash-row-load">
                          {live ? (
                            <ServerUsageMeters
                              compact
                              cpuPercent={s.cpuPercent}
                              memUsedBytes={s.memUsedBytes}
                              history={s.usageHistory}
                            />
                          ) : null}
                        </div>
                        <div className="btn-row dash-row-actions">
                          {live ? (
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
                        </div>
                      </li>
                    );
                  })}
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

            <section className="panel dash-section" aria-labelledby="dash-hosts-h">
              <div className="dash-section-head">
                <h3 id="dash-hosts-h">
                  Hosts {nodeList.length ? <span className="dash-count">{nodeList.length}</span> : null}
                </h3>
              </div>
              {nodes.isLoading ? (
                <div className="skeleton" aria-hidden>
                  <div className="skeleton-row" />
                </div>
              ) : nodes.isError ? (
                <p className="error" role="alert">
                  {(nodes.error as Error).message || "Couldn’t load nodes."}
                </p>
              ) : nodeList.length ? (
                <ul className="dash-rows">
                  {nodeList.map((n) => {
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
                    const state = hostState(n);
                    const tag = (() => {
                      const raw = n.badge ?? n.placement ?? n.kind ?? "";
                      if (!raw) return null;
                      const lower = raw.toLowerCase();
                      if (lower === "local") return "Local";
                      if (lower.includes(n.name.toLowerCase())) return null;
                      return raw;
                    })();
                    const hosted = serversOnNode(n.id);
                    const hasUsage =
                      n.cpuPercent != null || n.memUsedBytes != null || n.freeDiskBytes != null;
                    const hostAlerts = (n.alerts ?? []).filter((a) => a.scope === "host");
                    const hot = hostAlerts.some((a) => a.tone === "danger")
                      ? " is-hot tone-danger"
                      : hostAlerts.length
                        ? " is-hot tone-warn"
                        : "";
                    return (
                      <li
                        key={n.id}
                        className={`dash-row host-row state-${state}${state === "online" ? "" : " is-idle"}${hot}`}
                      >
                        <div className="dash-row-id">
                          <span className={`dash-dot state-${state}`} aria-hidden />
                          <div className="dash-row-text">
                            <strong>
                              {n.name}
                              {tag ? <span className="dash-tag">{tag}</span> : null}
                            </strong>
                            <p className="dash-row-meta">
                              <span className={`dash-state state-${state}`}>
                                {nodePresenceLabel({
                                  status: n.status,
                                  agentVersion: n.agentVersion,
                                })}
                              </span>
                              <span>
                                {hosted} {hosted === 1 ? "server" : "servers"}
                              </span>
                              <span>Seen {relativeTime(String(n.lastSeenAt))}</span>
                            </p>
                            {presenceHint ? (
                              <p className="muted status-inline dash-row-hint">{presenceHint}</p>
                            ) : null}
                            {caps.length ? (
                              <details className="dash-node-caps">
                                <summary className="linkish">Host details</summary>
                                <p className="muted small status-inline">{caps.join(" · ")}</p>
                              </details>
                            ) : null}
                          </div>
                        </div>
                        <div className="dash-row-load">
                          {hasUsage ? (
                            <HostUsageMeters
                              compact
                              cpuPercent={n.cpuPercent}
                              memUsedBytes={n.memUsedBytes}
                              memTotalBytes={n.memTotalBytes}
                              freeDiskBytes={n.freeDiskBytes}
                              history={n.usageHistory}
                            />
                          ) : (
                            <span className="muted small">No usage yet</span>
                          )}
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
          </div>

          <aside className="dash-rail" aria-label="Backups and activity">
          <section className="panel stack dash-section">
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
          <section className="panel stack dash-section dash-quiet">
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
                          {label ? <span className="muted activity-server">{label}</span> : null}
                          <span className={`activity-status status-${item.status}`}>
                            {statusLabel(item.status)}
                          </span>
                          <span className="muted activity-time">{relativeTime(item.createdAt)}</span>
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
          </aside>
        </div>
      </div>
    </div>
  );
}
