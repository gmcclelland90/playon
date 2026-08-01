import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { can, type PublicUser } from "@playon/shared";
import { api } from "../api";

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

  const servers = useQuery({ queryKey: ["servers"], queryFn: api.servers, refetchInterval: 5000 });
  const skills = useQuery({ queryKey: ["skills"], queryFn: api.skills });
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
  const achievements = useQuery({
    queryKey: ["achievements"],
    queryFn: api.achievements,
    refetchInterval: 20_000,
  });

  const createSnap = useMutation({
    mutationFn: (serverId: string) => api.createSnapshot({ serverId, label: "manual" }),
    onSuccess: async () => {
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
    <div className="pane dashboard" style={{ maxWidth: 1100, margin: "0 auto", width: "100%" }}>
      <div className="stack">
        <div>
          <h2>Dashboard</h2>
          <p className="muted" style={{ margin: 0 }}>
            Tonight&apos;s host view — servers, nodes, backups, and recent agent tools.
          </p>
        </div>

        <div className="dash-strip" role="group" aria-label="Status summary">
          <div>
            <strong>{running}</strong>
            <span className="muted">running</span>
          </div>
          <div>
            <strong>{stopped}</strong>
            <span className="muted">stopped</span>
          </div>
          <div>
            <strong>{errored}</strong>
            <span className="muted">error</span>
          </div>
          <div>
            <strong>{skills.data?.skills?.length ?? "…"}</strong>
            <span className="muted">skills</span>
          </div>
          <div>
            <strong>{nodes.data?.nodes?.length ?? "…"}</strong>
            <span className="muted">nodes</span>
          </div>
        </div>

        {achievements.data ? (
          <section className="panel stack" aria-label="Host achievements">
            <div className="dash-section-head">
              <h3>Host trophies</h3>
              <span className="muted">
                {achievements.data.unlocked.length}/{achievements.data.unlocked.length + achievements.data.locked.length}
              </span>
            </div>
            <ul className="list compact-list achievement-list">
              {achievements.data.unlocked.map((a) => (
                <li key={a.id} className="achievement-unlocked">
                  <div>
                    <strong>{a.title}</strong>
                    <div className="muted">{a.description}</div>
                  </div>
                </li>
              ))}
              {achievements.data.locked.map((a) => (
                <li key={a.id} className="achievement-locked">
                  <div>
                    <strong>{a.title}</strong>
                    <div className="muted">{a.description}</div>
                  </div>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        <div className="dash-grid">
          <section className="panel stack">
            <div className="dash-section-head">
              <h3>Servers</h3>
              <Link to="/servers">Manage →</Link>
            </div>
            {servers.isLoading ? (
              <div className="skeleton" aria-hidden>
                <div className="skeleton-row" />
              </div>
            ) : serverList.length ? (
              <ul className="list compact-list">
                {serverList.map((s) => (
                  <li key={s.id}>
                    <div>
                      <strong>{s.name}</strong>
                      <div className="muted">
                        {s.game ?? "—"} · <code>{s.status}</code> · {s.runtimeMode}
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
                          Off-node
                        </button>
                      ) : null}
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <div className="empty-hint">
                <strong>No servers</strong>
                <p className="muted" style={{ margin: 0 }}>
                  Create one on <Link to="/servers">Servers</Link> or ask chat.
                </p>
              </div>
            )}
          </section>

          <section className="panel stack">
            <div className="dash-section-head">
              <h3>Nodes</h3>
            </div>
            {nodes.isLoading ? (
              <div className="skeleton" aria-hidden>
                <div className="skeleton-row" />
              </div>
            ) : nodes.data?.nodes?.length ? (
              <ul className="list compact-list">
                {nodes.data.nodes.map((n) => (
                  <li key={n.id}>
                    <div>
                      <strong>{n.name}</strong>
                      <div className="muted">
                        <span className={`node-status node-${n.status}`}>{n.status}</span>
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
                <p className="muted" style={{ margin: 0 }}>
                  Remote node-agents appear here after heartbeat registration.
                </p>
              </div>
            )}
          </section>

          <section className="panel stack">
            <div className="dash-section-head">
              <h3>Skills</h3>
            </div>
            {skills.data?.skills?.length ? (
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
              <p className="muted" style={{ margin: 0 }}>
                No skills discovered.
              </p>
            )}
            {(skills.data?.skills?.length ?? 0) > 8 ? (
              <p className="muted" style={{ margin: 0 }}>
                +{(skills.data?.skills.length ?? 0) - 8} more on <Link to="/servers">Servers</Link>
              </p>
            ) : null}
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
                        onClick={() => {
                          if (
                            window.confirm(
                              `Restore snapshot "${snap.label}" onto ${serverName(snap.serverId)}?`,
                            )
                          ) {
                            restoreSnap.mutate(snap.id);
                          }
                        }}
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
                <p className="muted" style={{ margin: 0 }}>
                  Snapshot a server above, or let scheduled retention create them.
                </p>
              </div>
            )}
            {createSnap.isError ? (
              <p className="error">{(createSnap.error as Error).message}</p>
            ) : null}
            {restoreSnap.isError ? (
              <p className="error">{(restoreSnap.error as Error).message}</p>
            ) : null}
            {offnodeBackup.isError ? (
              <p className="error">{(offnodeBackup.error as Error).message}</p>
            ) : null}

            <h4 style={{ margin: "0.75rem 0 0" }}>Off-node</h4>
            {backupTarget.data?.target ? (
              <p className="muted" style={{ margin: 0 }}>
                Target: <code>{backupTarget.data.target.rootPath}</code>
              </p>
            ) : (
              <p className="muted" style={{ margin: 0 }}>
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
                        onClick={() => {
                          if (window.confirm(`Restore off-node backup "${b.label}"?`)) {
                            restoreOffnode.mutate(b.id);
                          }
                        }}
                      >
                        Restore
                      </button>
                    ) : null}
                  </li>
                ))}
              </ul>
            ) : null}
            {restoreOffnode.isError ? (
              <p className="error">{(restoreOffnode.error as Error).message}</p>
            ) : null}
          </section>
        </div>

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
                  <span className={`activity-status status-${item.status}`}>{item.status}</span>
                  <span className="muted">{relativeTime(item.createdAt)}</span>
                </li>
              ))}
            </ul>
          ) : (
            <div className="empty-hint">
              <strong>Quiet so far</strong>
              <p className="muted" style={{ margin: 0 }}>
                Tool calls from admin chat show up here.
              </p>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
