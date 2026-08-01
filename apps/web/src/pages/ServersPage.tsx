import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { can, type PublicUser } from "@playon/shared";
import { api, type ServerDetail } from "../api";
import { useServerLiveLogs } from "../hooks/useServerLiveLogs";

export function ServersPage({ user }: { user: PublicUser }) {
  const qc = useQueryClient();
  const [selectedId, setSelectedId] = useState<string | undefined>();
  const [placeSkill, setPlaceSkill] = useState<string | undefined>();
  const [selectedNodeId, setSelectedNodeId] = useState<string>("");
  const [importMode, setImportMode] = useState<"local" | "sftp">("local");
  const [importPath, setImportPath] = useState("");
  const [importName, setImportName] = useState("");
  const [sftpHost, setSftpHost] = useState("");
  const [sftpUser, setSftpUser] = useState("");
  const [sftpPassword, setSftpPassword] = useState("");
  const [sftpRemote, setSftpRemote] = useState("");
  const [importReport, setImportReport] = useState<string | null>(null);
  const canRestore = can(user.role, "snapshots.restore");
  const servers = useQuery({ queryKey: ["servers"], queryFn: api.servers, refetchInterval: 3000 });
  const skills = useQuery({ queryKey: ["skills"], queryFn: api.skills });
  const placement = useQuery({
    queryKey: ["placement", placeSkill],
    queryFn: () => api.placement(placeSkill!),
    enabled: !!placeSkill,
  });
  const nodes = useQuery({ queryKey: ["nodes"], queryFn: api.nodes, refetchInterval: 10_000 });
  const detail = useQuery({
    queryKey: ["server-detail", selectedId],
    queryFn: () => api.serverDetail(selectedId!),
    enabled: !!selectedId,
    refetchInterval: 8000,
  });
  const snapshots = useQuery({
    queryKey: ["snapshots", selectedId],
    queryFn: () => api.snapshots(selectedId),
    enabled: !!selectedId,
  });
  const health = useQuery({
    queryKey: ["server-health", selectedId],
    queryFn: () => api.serverHealth(selectedId!),
    enabled: !!selectedId,
    refetchInterval: 12_000,
  });
  const live = useServerLiveLogs(selectedId, detail.data?.runtime.logs);

  const create = useMutation({
    mutationFn: (args: { skillName: string; nodeId?: string }) => api.createServer(args),
    onSuccess: async (data) => {
      setSelectedId(data.server.id);
      setPlaceSkill(undefined);
      setSelectedNodeId("");
      await qc.invalidateQueries({ queryKey: ["servers"] });
      await qc.invalidateQueries({ queryKey: ["panel"] });
    },
  });

  const start = useMutation({
    mutationFn: (id: string) => api.startServer(id),
    onSuccess: async (_data, id) => {
      setSelectedId(id);
      await qc.invalidateQueries({ queryKey: ["servers"] });
      await qc.invalidateQueries({ queryKey: ["server-detail", id] });
      await qc.invalidateQueries({ queryKey: ["panel"] });
    },
  });

  const stop = useMutation({
    mutationFn: (id: string) => api.stopServer(id),
    onSuccess: async (_data, id) => {
      await qc.invalidateQueries({ queryKey: ["servers"] });
      await qc.invalidateQueries({ queryKey: ["server-detail", id] });
      await qc.invalidateQueries({ queryKey: ["panel"] });
    },
  });

  const restart = useMutation({
    mutationFn: (id: string) => api.restartServer(id),
    onSuccess: async (_data, id) => {
      setSelectedId(id);
      await qc.invalidateQueries({ queryKey: ["servers"] });
      await qc.invalidateQueries({ queryKey: ["server-detail", id] });
      await qc.invalidateQueries({ queryKey: ["panel"] });
    },
  });

  const createSnap = useMutation({
    mutationFn: (id: string) => api.createSnapshot({ serverId: id, label: "manual" }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["snapshots", selectedId] });
      await qc.invalidateQueries({ queryKey: ["snapshots"] });
    },
  });

  const restoreSnap = useMutation({
    mutationFn: (id: string) => api.restoreSnapshot(id),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["snapshots", selectedId] });
      await qc.invalidateQueries({ queryKey: ["servers"] });
      await qc.invalidateQueries({ queryKey: ["server-detail", selectedId] });
    },
  });

  const relocate = useMutation({
    mutationFn: (args: { id: string; targetNodeId: string }) =>
      api.relocateServer(args.id, args.targetNodeId),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["servers"] });
      await qc.invalidateQueries({ queryKey: ["server-detail", selectedId] });
      await qc.invalidateQueries({ queryKey: ["snapshots"] });
    },
  });

  const importLocal = useMutation({
    mutationFn: () =>
      importMode === "sftp"
        ? api.importServerSftp({
            host: sftpHost.trim(),
            username: sftpUser.trim(),
            password: sftpPassword || undefined,
            remotePath: sftpRemote.trim(),
            serverName: importName.trim() || undefined,
          })
        : api.importServerLocal({
            sourcePath: importPath.trim(),
            serverName: importName.trim() || undefined,
          }),
    onSuccess: async (data) => {
      setSelectedId(data.import.server.id);
      setImportReport(
        `Imported ${data.import.server.name} · skill ${data.import.skillName} · baseline ${data.import.baselineSnapshotId.slice(0, 8)}…`,
      );
      setImportPath("");
      setSftpPassword("");
      await qc.invalidateQueries({ queryKey: ["servers"] });
      await qc.invalidateQueries({ queryKey: ["skills"] });
      await qc.invalidateQueries({ queryKey: ["snapshots"] });
      await qc.invalidateQueries({ queryKey: ["panel"] });
    },
  });

  const selectedDetail: ServerDetail | undefined = detail.data;

  return (
    <div className="pane" style={{ maxWidth: 960, margin: "0 auto", width: "100%" }}>
      <div className="stack">
        <div>
          <h2>Servers</h2>
          <p className="muted" style={{ margin: 0 }}>
            Runtime: <code>{servers.data?.runtimeMode ?? "…"}</code>
            {" · "}
            Join host: <code>{servers.data?.advertiseHost ?? "…"}</code>
          </p>
        </div>

        <div className="panel stack">
          <h2>Skills</h2>
          {skills.data?.skills?.length ? (
            <ul className="list">
              {skills.data.skills.map((skill) => (
                <li key={skill.id}>
                  <div>
                    <strong>{skill.name}</strong>
                    <div className="muted">
                      {skill.game ?? skill.id} · v{skill.version}
                    </div>
                  </div>
                  <div className="btn-row">
                    <button
                      className="btn btn-primary"
                      type="button"
                      disabled={create.isPending}
                      onClick={() => {
                        setPlaceSkill(skill.name);
                        setSelectedNodeId("");
                      }}
                    >
                      Place…
                    </button>
                    <button
                      className="btn"
                      type="button"
                      onClick={() => {
                        void api.exportSkill(skill.name).catch((err: Error) => {
                          window.alert(err.message);
                        });
                      }}
                    >
                      Export
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          ) : skills.isLoading ? (
            <div className="skeleton" aria-hidden>
              <div className="skeleton-row" />
              <div className="skeleton-row" />
            </div>
          ) : (
            <div className="empty-hint">
              <strong>No skills on disk</strong>
              <p className="muted" style={{ margin: 0 }}>
                Skills live under <code>skills/</code>. Sync the repo or add a draft from chat, then refresh.
              </p>
            </div>
          )}
          {create.isError ? <p className="error">{(create.error as Error).message}</p> : null}
        </div>

        <form
          className="panel stack"
          onSubmit={(e) => {
            e.preventDefault();
            importLocal.mutate();
          }}
        >
          <h2>Import existing server</h2>
          <p className="muted" style={{ margin: 0 }}>
            Pull from a local disk path or SFTP. Copies into a PlayOn jail, attaches/detects/drafts a
            skill, then baselines.
          </p>
          <label className="field">
            <span>Source</span>
            <select
              value={importMode}
              onChange={(e) => setImportMode(e.target.value as "local" | "sftp")}
            >
              <option value="local">Local path</option>
              <option value="sftp">SFTP</option>
            </select>
          </label>
          {importMode === "local" ? (
            <label className="field">
              <span>Source path</span>
              <input
                value={importPath}
                onChange={(e) => setImportPath(e.target.value)}
                placeholder="C:\\games\\my-server or /home/lan/valheim"
                required
              />
            </label>
          ) : (
            <>
              <label className="field">
                <span>Host</span>
                <input
                  value={sftpHost}
                  onChange={(e) => setSftpHost(e.target.value)}
                  placeholder="192.168.1.50"
                  required
                />
              </label>
              <label className="field">
                <span>Username</span>
                <input
                  value={sftpUser}
                  onChange={(e) => setSftpUser(e.target.value)}
                  required
                  autoComplete="off"
                />
              </label>
              <label className="field">
                <span>Password</span>
                <input
                  type="password"
                  value={sftpPassword}
                  onChange={(e) => setSftpPassword(e.target.value)}
                  required
                  autoComplete="off"
                />
              </label>
              <label className="field">
                <span>Remote path</span>
                <input
                  value={sftpRemote}
                  onChange={(e) => setSftpRemote(e.target.value)}
                  placeholder="/home/lan/game-server"
                  required
                />
              </label>
            </>
          )}
          <label className="field">
            <span>Display name (optional)</span>
            <input
              value={importName}
              onChange={(e) => setImportName(e.target.value)}
              placeholder="Friday LAN"
            />
          </label>
          <div className="btn-row">
            <button className="btn btn-primary" type="submit" disabled={importLocal.isPending}>
              {importLocal.isPending ? "Importing…" : "Import"}
            </button>
            {importReport ? <span className="ok">{importReport}</span> : null}
          </div>
          {importLocal.isError ? (
            <p className="error">{(importLocal.error as Error).message}</p>
          ) : null}
        </form>

        {placeSkill ? (
          <div className="panel stack">
            <div className="dash-section-head">
              <h2 style={{ margin: 0 }}>Place {placeSkill}</h2>
              <button type="button" className="btn btn-ghost btn-compact" onClick={() => setPlaceSkill(undefined)}>
                Cancel
              </button>
            </div>
            <p className="muted" style={{ margin: 0 }}>
              Ranked by OS, Docker, disk, and online status. Leave node on recommended to auto-pick.
            </p>
            {placement.isLoading ? (
              <div className="skeleton" aria-hidden>
                <div className="skeleton-row" />
              </div>
            ) : placement.data?.placement ? (
              <>
                <label className="field">
                  <span>Node</span>
                  <select
                    value={selectedNodeId || placement.data.placement.recommendedNodeId || ""}
                    onChange={(e) => setSelectedNodeId(e.target.value)}
                  >
                    {placement.data.placement.candidates.map((c) => (
                      <option key={c.nodeId} value={c.nodeId} disabled={!c.eligible}>
                        {c.name} ({c.status}
                        {c.eligible ? "" : " · ineligible"} · score {c.score})
                        {c.nodeId === placement.data.placement.recommendedNodeId ? " · recommended" : ""}
                      </option>
                    ))}
                  </select>
                </label>
                <ul className="list compact-list">
                  {placement.data.placement.candidates.map((c) => (
                    <li key={c.nodeId}>
                      <div>
                        <strong>{c.name}</strong>
                        <div className="muted">
                          <span className={`node-status node-${c.status}`}>{c.status}</span>
                          {" · "}
                          {c.os}
                          {c.docker ? " · Docker" : ""}
                          {" · "}
                          {c.eligible ? "eligible" : "blocked"}
                        </div>
                        <div className="muted dash-clip">{c.reasons.join(" · ")}</div>
                      </div>
                    </li>
                  ))}
                </ul>
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={create.isPending || !placement.data.placement.recommendedNodeId}
                  onClick={() =>
                    create.mutate({
                      skillName: placeSkill,
                      nodeId:
                        selectedNodeId ||
                        placement.data.placement.recommendedNodeId ||
                        undefined,
                    })
                  }
                >
                  {create.isPending ? "Creating…" : "Create on node"}
                </button>
              </>
            ) : (
              <p className="error">{(placement.error as Error | undefined)?.message ?? "No placement"}</p>
            )}
          </div>
        ) : null}

        <div className="panel">
          <h2>Running inventory</h2>
          {servers.isLoading ? (
            <div className="skeleton" aria-hidden>
              <div className="skeleton-row" />
              <div className="skeleton-row" />
            </div>
          ) : servers.data?.servers?.length ? (
            <ul className="list server-list">
              {servers.data.servers.map((s) => (
                <li key={s.id}>
                  <div>
                    <strong>{s.name}</strong>
                    <div className="muted">
                      {s.game} · {s.runtimeMode}
                    </div>
                    <span
                      className={`status ${
                        s.status === "running" ? "" : s.status === "error" ? "error" : "stopped"
                      }`}
                    >
                      {s.status}
                    </span>
                  </div>
                  <div className="btn-row">
                    <button className="btn btn-ghost btn-compact" type="button" onClick={() => setSelectedId(s.id)}>
                      Details
                    </button>
                    <button
                      className="btn btn-ghost btn-compact"
                      type="button"
                      disabled={start.isPending}
                      onClick={() => start.mutate(s.id)}
                    >
                      Start
                    </button>
                    <button
                      className="btn btn-ghost btn-compact"
                      type="button"
                      disabled={stop.isPending}
                      onClick={() => stop.mutate(s.id)}
                    >
                      Stop
                    </button>
                    <button
                      className="btn btn-ghost btn-compact"
                      type="button"
                      disabled={restart.isPending}
                      onClick={() => restart.mutate(s.id)}
                    >
                      Restart
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <div className="empty-hint">
              <strong>No servers yet</strong>
              <p className="muted" style={{ margin: 0 }}>
                Create one from a skill above, or ask chat to spin up Paper for the LAN.
              </p>
            </div>
          )}
        </div>

        {selectedId ? (
          <div className="panel stack">
            <h2>Server details</h2>
            {detail.isLoading ? (
              <div className="skeleton" aria-hidden>
                <div className="skeleton-row" />
                <div className="skeleton-row" />
              </div>
            ) : selectedDetail ? (
              <>
                <p className="muted" style={{ margin: 0 }}>
                  <strong>{selectedDetail.server.name}</strong>
                  {" · "}
                  DB status: <code>{live.liveStatus ?? selectedDetail.server.status}</code>
                  {" · "}
                  runtime: <code>{selectedDetail.runtime.kind}</code>
                  {selectedDetail.server.nodeId ? (
                    <>
                      {" · "}
                      node: <code>{selectedDetail.server.nodeId}</code>
                    </>
                  ) : null}
                  {selectedDetail.runtime.containerStatus
                    ? ` · container: ${selectedDetail.runtime.containerStatus}`
                    : ""}
                </p>
                {(nodes.data?.nodes?.length ?? 0) > 1 ? (
                  <label className="field">
                    <span>Relocate to node</span>
                    <div className="btn-row">
                      <select
                        id="relocate-node"
                        defaultValue=""
                        onChange={(e) => {
                          const target = e.target.value;
                          if (!target || !selectedId) return;
                          if (
                            window.confirm(
                              `Relocate this server to ${target}? A pre-relocate snapshot will be taken.`,
                            )
                          ) {
                            relocate.mutate({ id: selectedId, targetNodeId: target });
                          }
                          e.target.value = "";
                        }}
                      >
                        <option value="" disabled>
                          Choose node…
                        </option>
                        {nodes.data?.nodes
                          .filter((n) => n.id !== selectedDetail.server.nodeId)
                          .map((n) => (
                            <option key={n.id} value={n.id}>
                              {n.name} ({n.status})
                            </option>
                          ))}
                      </select>
                      {relocate.isPending ? <span className="muted">Moving…</span> : null}
                    </div>
                  </label>
                ) : null}
                {relocate.isError ? (
                  <p className="error">{(relocate.error as Error).message}</p>
                ) : null}
                {selectedDetail.runtime.join ? (
                  <p style={{ margin: 0 }}>
                    Join:{" "}
                    <code>
                      {selectedDetail.runtime.join.address}:{selectedDetail.runtime.join.port}
                    </code>
                    {selectedDetail.runtime.kind === "docker" ? (
                      <span className="muted"> (real Docker port publish)</span>
                    ) : (
                      <span className="muted"> ({selectedDetail.runtime.kind} runtime)</span>
                    )}
                  </p>
                ) : null}
                {selectedDetail.runtime.containerName ? (
                  <p className="muted" style={{ margin: 0 }}>
                    Container: <code>{selectedDetail.runtime.containerName}</code>
                    {selectedDetail.runtime.imageHint ? (
                      <>
                        {" · "}
                        <code>{selectedDetail.runtime.imageHint}</code>
                      </>
                    ) : null}
                  </p>
                ) : null}
                <div>
                  <h3 style={{ marginBottom: "0.35rem" }}>Health</h3>
                  {health.isLoading ? (
                    <p className="muted" style={{ margin: 0 }}>
                      Checking…
                    </p>
                  ) : health.data ? (
                    <ul className="list compact-list">
                      <li>
                        <div>
                          <strong>{health.data.ok ? "Healthy" : "Issues"}</strong>
                          <div className="muted">
                            {(health.data.checks ?? [])
                              .map((c) => `${c.name}: ${c.ok ? "ok" : "fail"}`)
                              .join(" · ") || "No checks declared"}
                          </div>
                        </div>
                      </li>
                    </ul>
                  ) : (
                    <p className="muted" style={{ margin: 0 }}>
                      Health unavailable.
                    </p>
                  )}
                </div>

                <div>
                  <div className="dash-section-head">
                    <h3 style={{ marginBottom: 0 }}>Snapshots</h3>
                    <button
                      type="button"
                      className="btn btn-ghost btn-compact"
                      disabled={createSnap.isPending}
                      onClick={() => createSnap.mutate(selectedId)}
                    >
                      Take snapshot
                    </button>
                  </div>
                  {snapshots.data?.snapshots?.length ? (
                    <ul className="list compact-list">
                      {snapshots.data.snapshots.map((snap) => (
                        <li key={snap.id}>
                          <div>
                            <strong>{snap.label}</strong>
                            <div className="muted">{new Date(snap.createdAt).toLocaleString()}</div>
                          </div>
                          {canRestore ? (
                            <button
                              type="button"
                              className="btn btn-ghost btn-compact"
                              disabled={restoreSnap.isPending}
                              onClick={() => {
                                if (window.confirm(`Restore "${snap.label}"?`)) {
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
                    <p className="muted" style={{ margin: 0 }}>
                      No snapshots for this server yet.
                    </p>
                  )}
                </div>

                <div>
                  <h3 style={{ marginBottom: "0.35rem" }}>Live logs</h3>
                  <pre
                    className="chat-log"
                    style={{
                      maxHeight: 240,
                      overflow: "auto",
                      fontSize: "0.8rem",
                      whiteSpace: "pre-wrap",
                    }}
                  >
                    {live.lines.length
                      ? live.lines.join("\n")
                      : "No logs yet — start the server to stream container output."}
                  </pre>
                </div>
              </>
            ) : (
              <p className="error">Could not load details.</p>
            )}
            {start.isError ? <p className="error">{(start.error as Error).message}</p> : null}
            {stop.isError ? <p className="error">{(stop.error as Error).message}</p> : null}
            {createSnap.isError ? <p className="error">{(createSnap.error as Error).message}</p> : null}
            {restoreSnap.isError ? (
              <p className="error">{(restoreSnap.error as Error).message}</p>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}
