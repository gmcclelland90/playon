import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { can, type PublicUser } from "@playon/shared";
import { api } from "../api";
import { statusLabel } from "../status";

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
  const restoreCancelRef = useRef<HTMLButtonElement>(null);
  const [pendingRestore, setPendingRestore] = useState<
    | { kind: "snapshot"; id: string; label: string; serverLabel: string }
    | { kind: "offnode"; id: string; label: string }
    | null
  >(null);

  useEffect(() => {
    if (!pendingRestore) return;
    restoreCancelRef.current?.focus();
  }, [pendingRestore]);
  const [opsNotice, setOpsNotice] = useState<string | null>(null);

  function flashOpsNotice(message: string) {
    setOpsNotice(message);
    window.setTimeout(() => setOpsNotice(null), 3000);
  }

  const servers = useQuery({ queryKey: ["servers"], queryFn: api.servers, refetchInterval: 5000 });
  const skills = useQuery({ queryKey: ["skills"], queryFn: () => api.skills() });
  const nodes = useQuery({ queryKey: ["nodes"], queryFn: api.nodes, refetchInterval: 10_000 });
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
    queryFn: () => api.activity(30),
    refetchInterval: 8_000,
  });
  const createSnap = useMutation({
    mutationFn: (serverId: string) => api.createSnapshot({ serverId, label: "manual" }),
    onSuccess: async () => {
      flashOpsNotice("Snapshot started");
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

  const serverList = servers.data?.servers ?? [];
  const running = serverList.filter((s) => s.status === "running").length;
  const stopped = serverList.filter((s) => s.status === "stopped").length;
  const errored = serverList.filter((s) => s.status === "error").length;
  const serverName = (id: string) => serverList.find((s) => s.id === id)?.name ?? id.slice(0, 8);

  return (
    <div className="pane dashboard dashboard-page">
      <div className="stack">
        <header className="page-header">
          <h2>Dashboard</h2>
          <p className="lede">
            Tonight&apos;s host view — servers, nodes, backups, and recent agent tools.
          </p>
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
              <strong>{skills.data?.skills?.length ?? 0}</strong> skills ·{" "}
              <strong>{nodes.data?.nodes?.length ?? 0}</strong> nodes
            </>
          )}
          {canMap ? <Link to="/">Open map</Link> : null}
        </p>

        {opsNotice ? (
          <p className="ok dash-ops-notice" role="status" aria-live="polite">
            {opsNotice}
          </p>
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
                ref={restoreCancelRef}
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
              {canMap ? <Link to="/">Open map →</Link> : null}
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
                      <strong>{s.name}</strong>
                      <div className="muted canvas-status-row">
                        <span className={`server-status-pill status-${s.status}`}>
                          {statusLabel(s.status)}
                        </span>
                        <span>{s.game ?? "—"}</span>
                        {s.runtimeMode ? <span>{s.runtimeMode}</span> : null}
                      </div>
                    </div>
                    <div className="btn-row">
                      <button
                        type="button"
                        className="btn btn-ghost btn-compact"
                        disabled={createSnap.isPending}
                        onClick={() => createSnap.mutate(s.id)}
                      >
                        Snapshot
                      </button>
                      {backupTarget.data?.target ? (
                        <button
                          type="button"
                          className="btn btn-ghost btn-compact"
                          disabled={offnodeBackup.isPending}
                          onClick={() => offnodeBackup.mutate(s.id)}
                        >
                          USB/NAS copy
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
                {nodes.data.nodes.map((n) => (
                  <li key={n.id}>
                    <div>
                      <strong>{n.name}</strong>
                      <div className="muted">
                        <span className={`node-status node-${n.status}`}>
                          {statusLabel(n.status)}
                        </span>
                        {" · "}
                        {n.os}
                        {n.docker ? " · Docker" : " · no Docker"} · free {formatBytes(n.freeDiskBytes)}
                        {n.agentVersion ? ` · agent ${n.agentVersion}` : ""}
                      </div>
                      <div className="muted">Seen {relativeTime(String(n.lastSeenAt))}</div>
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <div className="empty-hint">
                <strong>Local host only</strong>
                <p className="muted status-inline">
                  Remote node-agents appear here after heartbeat registration.
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
                {snapshots.data.snapshots.slice(0, 12).map((snap) => (
                  <li key={snap.id}>
                    <div>
                      <strong>{snap.label}</strong>
                      <div className="muted">
                        {serverName(snap.serverId)} · {relativeTime(snap.createdAt)}
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
          </div>

          <div className="dash-quiet">
            <section className="panel stack">
              <div className="dash-section-head">
                <h3>Skills</h3>
              </div>
              {skills.isLoading ? (
                <div className="skeleton" aria-hidden>
                  <div className="skeleton-row" />
                  <div className="skeleton-row compact" />
                </div>
              ) : skills.data?.skills?.length ? (
                <ul className="list compact-list">
                  {skills.data.skills.slice(0, 8).map((skill) => (
                    <li key={skill.id}>
                      <div>
                        <strong>{skill.name}</strong>
                        <div className="muted">
                          {skill.game ?? skill.id} · v{skill.version}
                          {skill.tags?.length ? ` · ${skill.tags.slice(0, 3).join(", ")}` : ""}
                        </div>
                        {skill.description ? (
                          <div className="muted dash-clip">{skill.description}</div>
                        ) : null}
                      </div>
                    </li>
                  ))}
                </ul>
              ) : (
                <div className="empty-hint">
                  <strong>No skills discovered</strong>
                  <p className="muted status-inline">Global skill packs show up here once loaded.</p>
                </div>
              )}
              {!skills.isLoading && (skills.data?.skills?.length ?? 0) > 8 ? (
                <p className="muted status-inline">
                  +{(skills.data?.skills.length ?? 0) - 8} more skills available to agents
                </p>
              ) : null}
            </section>

            <section className="panel stack">
              <div className="dash-section-head">
                <h3>Agent activity</h3>
              </div>
              {activity.isLoading ? (
                <div className="skeleton" aria-hidden>
                  <div className="skeleton-row" />
                  <div className="skeleton-row" />
                </div>
              ) : activity.data?.activity?.length ? (
                <ul className="activity-feed">
                  {activity.data.activity.map((item) => (
                    <li key={item.id}>
                      <code className="activity-tool">{item.toolName}</code>
                      <span className={`activity-status status-${item.status}`}>
                        {statusLabel(item.status)}
                      </span>
                      <span className="muted">{relativeTime(item.createdAt)}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <div className="empty-hint">
                  <strong>Quiet so far</strong>
                  <p className="muted status-inline">
                    Tool calls from admin chat show up here.
                  </p>
                </div>
              )}
            </section>
          </div>
        </div>
      </div>
    </div>
  );
}
