import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { roleAtLeast, type PublicUser } from "@playon/shared";
import { api, type FsEntry } from "../api";
import { CodeEditor } from "../components/CodeEditor";

type TargetKind = "server" | "skill" | "draft";

type SelectedTarget =
  | { kind: "server"; id: string; label: string }
  | { kind: "skill"; id: string; label: string }
  | { kind: "draft"; id: string; label: string };

type TreeNodeState = {
  entries?: FsEntry[];
  loading?: boolean;
  error?: string;
  open?: boolean;
};

function joinPath(parent: string, name: string): string {
  if (!parent || parent === ".") return name;
  return `${parent.replace(/\\/g, "/").replace(/\/+$/, "")}/${name}`;
}

function sortEntries(entries: FsEntry[]): FsEntry[] {
  return [...entries].sort((a, b) => {
    if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

export function FilesPage({ user }: { user: PublicUser }) {
  const canBrowse = roleAtLeast(user.role, "operator");

  const [kind, setKind] = useState<TargetKind>("server");
  const [target, setTarget] = useState<SelectedTarget | null>(null);
  const [tree, setTree] = useState<Record<string, TreeNodeState>>({});
  const [activePath, setActivePath] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [saved, setSaved] = useState("");
  const [writable, setWritable] = useState(false);
  const [truncated, setTruncated] = useState(false);
  const [source, setSource] = useState<string | undefined>();
  const [loadError, setLoadError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [treeSlow, setTreeSlow] = useState(false);
  const [fileOpening, setFileOpening] = useState(false);
  const [treeFilter, setTreeFilter] = useState("");

  const dirty = activePath != null && draft !== saved && !fileOpening;

  function humanFsError(message: string): string {
    const m = message.trim();
    if (m === "list_failed" || m === "read_failed") {
      return "Couldn’t open that folder. Check the node is online, then Refresh.";
    }
    if (m === "file_truncated_reload_before_save") {
      return "This file is too large to save here. Edit it on the host or via Map chat.";
    }
    if (m === "nothing_to_save") return "Nothing to save yet.";
    if (m.includes("ENOENT") || m.toLowerCase().includes("not found")) {
      return "That path is gone — Refresh the tree.";
    }
    return m;
  }

  const servers = useQuery({
    queryKey: ["servers"],
    queryFn: () => api.servers(),
    enabled: canBrowse && kind === "server",
  });

  const skills = useQuery({
    queryKey: ["skills"],
    queryFn: () => api.skills(),
    enabled: canBrowse && kind === "skill",
  });

  const drafts = useQuery({
    queryKey: ["skill-drafts"],
    queryFn: () => api.skillDrafts(),
    enabled: canBrowse && kind === "draft",
  });

  const targetOptions = useMemo(() => {
    if (kind === "server") {
      return (servers.data?.servers ?? []).map((s) => ({
        id: s.id,
        label: s.name,
      }));
    }
    if (kind === "draft") {
      return (drafts.data?.drafts ?? []).map((d) => ({
        id: d.skillName,
        label: `${d.skillName} (${d.slug})`,
      }));
    }
    return (skills.data?.skills ?? []).map((s) => ({
      id: s.name,
      label: s.source ? `${s.name} · ${s.source}` : s.name,
    }));
  }, [kind, servers.data?.servers, skills.data?.skills, drafts.data?.drafts]);

  function confirmDiscard(): boolean {
    if (!dirty) return true;
    return window.confirm("Discard unsaved changes?");
  }

  function resetEditor() {
    setActivePath(null);
    setDraft("");
    setSaved("");
    setWritable(false);
    setTruncated(false);
    setSource(undefined);
    setLoadError(null);
    setFileOpening(false);
  }

  function selectKind(next: TargetKind) {
    if (next === kind) return;
    if (!confirmDiscard()) return;
    setKind(next);
    setTarget(null);
    setTree({});
    setTreeFilter("");
    resetEditor();
  }

  function selectTarget(id: string) {
    const option = targetOptions.find((o) => o.id === id);
    if (!option) return;
    const next: SelectedTarget = { kind, id: option.id, label: option.label };
    if (target?.kind === next.kind && target.id === next.id) return;
    if (!confirmDiscard()) return;
    setTarget(next);
    setTree({});
    setTreeFilter("");
    resetEditor();
  }

  async function listDir(relPath: string): Promise<FsEntry[]> {
    if (!target) return [];
    if (target.kind === "server") {
      const res = await api.serverFsList(target.id, relPath);
        return sortEntries(res.entries);
    }
    const res = await api.skillFsList(target.id, relPath);
    return sortEntries(res.entries);
  }

  function entryVisible(name: string): boolean {
    const q = treeFilter.trim().toLowerCase();
    if (!q) return true;
    return name.toLowerCase().includes(q);
  }

  async function ensureDir(relPath: string) {
    if (!target) return;
    setTree((prev) => ({
      ...prev,
      [relPath]: { ...prev[relPath], loading: true, error: undefined },
    }));
    try {
      const entries = await listDir(relPath);
      setTree((prev) => ({
        ...prev,
        [relPath]: { entries, loading: false, open: true },
      }));
    } catch (err) {
      setTree((prev) => ({
        ...prev,
        [relPath]: {
          ...prev[relPath],
          loading: false,
          error: err instanceof Error ? err.message : "list_failed",
        },
      }));
    }
  }

  useEffect(() => {
    if (!target) {
      setTreeSlow(false);
      return;
    }
    const current = target;
    let cancelled = false;
    setTreeSlow(false);
    setTree({ ".": { loading: true, open: true } });
    const slowTimer = window.setTimeout(() => {
      if (!cancelled) setTreeSlow(true);
    }, 2500);
    const load =
      current.kind === "server"
        ? api.serverFsList(current.id, ".")
        : api.skillFsList(current.id, ".");
    void load
      .then((res) => {
        if (cancelled) return;
        setTreeSlow(false);
        setTree({ ".": { entries: sortEntries(res.entries), loading: false, open: true } });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setTreeSlow(false);
        setTree({
          ".": {
            loading: false,
            open: true,
            error: err instanceof Error ? err.message : "list_failed",
          },
        });
      });
    return () => {
      cancelled = true;
      window.clearTimeout(slowTimer);
    };
  }, [target]);

  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [dirty]);

  async function openFile(relPath: string) {
    if (!target) return;
    if (activePath === relPath && !fileOpening) return;
    if (!confirmDiscard()) return;
    setLoadError(null);
    setNotice(null);
    setFileOpening(true);
    setActivePath(relPath);
    setDraft("");
    setSaved("");
    try {
      const file =
        target.kind === "server"
          ? await api.serverFsRead(target.id, relPath)
          : await api.skillFsRead(target.id, relPath);
      setDraft(file.content);
      setSaved(file.content);
      setWritable(file.writable);
      setTruncated(file.truncated);
      setSource(file.source);
    } catch (err) {
      resetEditor();
      setLoadError(humanFsError(err instanceof Error ? err.message : "read_failed"));
    } finally {
      setFileOpening(false);
    }
  }

  function toggleDir(relPath: string) {
    const node = tree[relPath];
    if (node?.open) {
      setTree((prev) => ({ ...prev, [relPath]: { ...prev[relPath], open: false } }));
      return;
    }
    if (node?.entries) {
      setTree((prev) => ({ ...prev, [relPath]: { ...prev[relPath], open: true } }));
      return;
    }
    void ensureDir(relPath);
  }

  const save = useMutation({
    mutationFn: async () => {
      if (!target || !activePath) throw new Error("nothing_to_save");
      if (truncated) throw new Error("file_truncated_reload_before_save");
      if (target.kind === "server") {
        return api.serverFsWrite(target.id, activePath, draft);
      }
      return api.skillFsWrite(target.id, activePath, draft);
    },
    onSuccess: () => {
      setSaved(draft);
      const where = target ? `${target.label}${activePath ? ` / ${activePath}` : ""}` : "file";
      setNotice(`Saved — wrote into ${where}`);
      window.setTimeout(() => setNotice(null), 4000);
    },
  });

  const readOnly = !writable || truncated || fileOpening;

  useEffect(() => {
    if (!activePath || readOnly || !dirty || !target) return;
    const onKey = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== "s") return;
      event.preventDefault();
      if (save.isPending || fileOpening) return;
      if (
        target.kind === "server" &&
        !window.confirm(
          `Save ${activePath} on ${target.label}? This writes into the live server folder.`,
        )
      ) {
        return;
      }
      save.mutate();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [activePath, readOnly, dirty, target, save, fileOpening]);

  function renderTree(relPath: string, depth: number): ReactNode {
    const node = tree[relPath];
    if (!node) return null;
    if (node.loading && !node.entries) {
      return (
        <p
          className="muted files-tree-status"
          style={{ paddingLeft: `${depth * 0.85}rem` }}
          role="status"
        >
          {treeSlow && relPath === "."
            ? "Still loading — large folders can take a few seconds…"
            : "Loading folder…"}
        </p>
      );
    }
    if (node.error) {
      return (
        <div
          className="stack tight files-tree-status"
          style={{ paddingLeft: `${depth * 0.85}rem` }}
        >
          <p className="error" role="alert">
            {humanFsError(node.error)}
          </p>
          <button
            type="button"
            className="btn btn-ghost btn-compact"
            onClick={() => void ensureDir(relPath)}
          >
            Retry
          </button>
        </div>
      );
    }
    if (!node.open || !node.entries) return null;

    return (
      <ul className="files-tree-list">
        {node.entries.map((entry) => {
          const childPath = joinPath(relPath, entry.name);
          if (entry.type === "dir") {
            const child = tree[childPath];
            const open = Boolean(child?.open);
            if (!entryVisible(entry.name) && !open) return null;
            return (
              <li key={childPath}>
                <button
                  type="button"
                  className="files-tree-item dir"
                  style={{ paddingLeft: `${depth * 0.85 + 0.35}rem` }}
                  aria-expanded={open}
                  onClick={() => toggleDir(childPath)}
                >
                  <span aria-hidden>{open ? "▾" : "▸"}</span>
                  <span>{entry.name}</span>
                </button>
                {open ? renderTree(childPath, depth + 1) : null}
              </li>
            );
          }
          if (!entryVisible(entry.name)) return null;
          return (
            <li key={childPath}>
              <button
                type="button"
                className={`files-tree-item file${activePath === childPath ? " active" : ""}`}
                style={{ paddingLeft: `${depth * 0.85 + 0.35}rem` }}
                onClick={() => void openFile(childPath)}
              >
                <span aria-hidden>·</span>
                <span>{entry.name}</span>
              </button>
            </li>
          );
        })}
      </ul>
    );
  }

  if (!canBrowse) {
    return (
      <div className="files-page">
        <p className="error" role="alert">
          Operator access required.
        </p>
      </div>
    );
  }

  return (
    <div className="files-page">
      <header className="files-header">
        <div>
          <h1>Files</h1>
          {!target ? (
            <p className="lede">
              Edit configs inside one server or skill folder — browsing stays inside that directory.
              Built-in platform skills are read-only.
            </p>
          ) : (
            <p className="muted status-inline">
              Inside <strong>{target.label}</strong>
              {activePath
                ? readOnly && !fileOpening
                  ? " — this file is read-only."
                    : target.kind === "server"
                    ? " — edits save into the live folder."
                    : " — package files for this skill."
                : " — pick a file to edit."}
            </p>
          )}
        </div>
      </header>

      <div className="files-toolbar">
        <div className="skills-tabs" role="tablist" aria-label="File target kind">
          {(
            [
              ["server", "Servers"],
              ["skill", "Skills"],
              ["draft", "Drafts"],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={kind === id}
              className={kind === id ? "active" : undefined}
              onClick={() => selectKind(id)}
            >
              {label}
            </button>
          ))}
        </div>
        <label className="files-target-select">
          <span className="muted">
            {kind === "server" ? "Choose server" : kind === "draft" ? "Choose draft" : "Choose skill"}
          </span>
          <select
            value={target?.id ?? ""}
            onChange={(e) => {
              if (!e.target.value) {
                if (!confirmDiscard()) return;
                setTarget(null);
                setTree({});
                resetEditor();
                return;
              }
              selectTarget(e.target.value);
            }}
          >
            <option value="">
              {kind === "server"
                ? "Choose a server…"
                : kind === "draft"
                  ? "Choose a draft…"
                  : "Choose a skill…"}
            </option>
            {targetOptions.map((o) => (
              <option key={o.id} value={o.id}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
      </div>

      {!target ? (
            <div className="empty-hint files-empty">
          <strong>Open a server folder</strong>
          <p className="muted status-inline">
            {kind === "server"
              ? "Pick a server to browse its live data directory. You can’t leave that folder."
              : kind === "draft"
                ? "Draft skills are agent work-in-progress packages until you promote them."
                : "Installed and platform skills expose their package files. Built-ins stay read-only."}
          </p>
          {targetOptions.length ? (
            <div className="files-quick-picks">
              {targetOptions.slice(0, 6).map((o) => (
                <button
                  key={o.id}
                  type="button"
                  className="btn btn-ghost btn-compact"
                  onClick={() => selectTarget(o.id)}
                >
                  {o.label}
                </button>
              ))}
            </div>
          ) : servers.isLoading || skills.isLoading || drafts.isLoading ? (
            <p className="muted">Loading…</p>
          ) : (
            <p className="muted status-inline">
              {kind === "server"
                ? "No servers yet — create one on the Map first."
                : kind === "draft"
                  ? "No drafts on this host."
                  : "No skills discovered yet."}
            </p>
          )}
        </div>
      ) : (
        <div className={`files-layout${activePath ? " has-file" : ""}`}>
          <aside className="files-sidebar" aria-label="File tree">
            <div className="files-sidebar-head">
              <strong>{target.label}</strong>
              <button
                type="button"
                className="linkish"
                onClick={() => void ensureDir(".")}
                disabled={tree["."]?.loading}
              >
                Refresh
              </button>
            </div>
            <label className="files-tree-filter">
              <span className="sr-only">Filter files</span>
              <input
                value={treeFilter}
                onChange={(e) => setTreeFilter(e.target.value)}
                placeholder="Filter files…"
                autoComplete="off"
              />
            </label>
            {renderTree(".", 0)}
          </aside>

          <section className="files-editor-pane" aria-label="Editor">
            {loadError ? (
              <p className="error" role="alert">
                {loadError}
              </p>
            ) : null}
            {notice ? (
              <p className="ok status-inline" role="status">
                {notice}
              </p>
            ) : null}
            {!activePath ? (
              <div className="empty-hint">
                <strong>Select a file</strong>
                <p className="muted status-inline">
                  Staying inside <strong>{target.label}</strong>
                  <span className="files-tree-hint"> — use the tree beside this pane</span>
                  <span className="files-tree-hint-mobile"> — pick a file in the list above</span>
                  . Open a config to edit.
                </p>
              </div>
            ) : (
              <>
                <div className="files-editor-bar">
                  <div className="files-editor-meta">
                    <button
                      type="button"
                      className="linkish files-back-to-tree"
                      onClick={() => {
                        if (!confirmDiscard()) return;
                        resetEditor();
                      }}
                    >
                      ← Files
                    </button>
                    <code title={activePath}>
                      {target.label} / {activePath}
                    </code>
                    {fileOpening ? <span className="muted">Opening…</span> : null}
                    {dirty ? <span className="files-dirty">Unsaved</span> : null}
                    {source ? <span className="muted">{source}</span> : null}
                    {readOnly && !fileOpening ? (
                      <span className="files-readonly">Read-only</span>
                    ) : null}
                  </div>
                  <div className="files-editor-actions btn-row">
                    <button
                      type="button"
                      className="btn btn-ghost btn-compact"
                      disabled={!dirty || save.isPending || fileOpening}
                      onClick={() => {
                        if (!window.confirm("Discard unsaved edits in this file?")) return;
                        setDraft(saved);
                      }}
                    >
                      Discard
                    </button>
                    <button
                      type="button"
                      className="btn btn-primary btn-compact"
                      disabled={!dirty || readOnly || save.isPending}
                      title="Ctrl+S"
                      onClick={() => {
                        if (
                          target.kind === "server" &&
                          !window.confirm(
                            `Save ${activePath} on ${target.label}? This writes into the live server folder.`,
                          )
                        ) {
                          return;
                        }
                        save.mutate();
                      }}
                    >
                      {save.isPending ? "Saving…" : dirty ? "Save · Ctrl+S" : "Save"}
                    </button>
                  </div>
                </div>
                {truncated ? (
                  <p className="error" role="alert">
                    File exceeds the read size limit and cannot be saved from this editor.
                  </p>
                ) : null}
                {!fileOpening && !writable && !truncated ? (
                  <p className="muted" role="status">
                    This location is read-only
                    {source === "platform" || source === "fixture"
                      ? " (built-in skill)."
                      : "."}
                  </p>
                ) : null}
                {save.isError ? (
                  <p className="error" role="alert">
                    {humanFsError((save.error as Error).message)}
                  </p>
                ) : null}
                <div className="files-monaco">
                  <CodeEditor
                    path={activePath}
                    value={draft}
                    onChange={setDraft}
                    readOnly={readOnly}
                  />
                </div>
              </>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
