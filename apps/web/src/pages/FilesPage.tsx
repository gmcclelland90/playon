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

  const dirty = activePath != null && draft !== saved;

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
  }

  function selectKind(next: TargetKind) {
    if (next === kind) return;
    if (!confirmDiscard()) return;
    setKind(next);
    setTarget(null);
    setTree({});
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
    if (!target) return;
    const current = target;
    let cancelled = false;
    setTree({ ".": { loading: true, open: true } });
    const load =
      current.kind === "server"
        ? api.serverFsList(current.id, ".")
        : api.skillFsList(current.id, ".");
    void load
      .then((res) => {
        if (cancelled) return;
        setTree({ ".": { entries: sortEntries(res.entries), loading: false, open: true } });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
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
    if (activePath === relPath) return;
    if (!confirmDiscard()) return;
    setLoadError(null);
    setNotice(null);
    try {
      const file =
        target.kind === "server"
          ? await api.serverFsRead(target.id, relPath)
          : await api.skillFsRead(target.id, relPath);
      setActivePath(file.path);
      setDraft(file.content);
      setSaved(file.content);
      setWritable(file.writable);
      setTruncated(file.truncated);
      setSource(file.source);
    } catch (err) {
      resetEditor();
      setLoadError(err instanceof Error ? err.message : "read_failed");
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
      setNotice("Saved");
      window.setTimeout(() => setNotice(null), 2500);
    },
  });

  function renderTree(relPath: string, depth: number): ReactNode {
    const node = tree[relPath];
    if (!node) return null;
    if (node.loading && !node.entries) {
      return (
        <p className="muted files-tree-status" style={{ paddingLeft: `${depth * 0.85}rem` }}>
          Loading…
        </p>
      );
    }
    if (node.error) {
      return (
        <p className="error files-tree-status" style={{ paddingLeft: `${depth * 0.85}rem` }}>
          {node.error}
        </p>
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
            return (
              <li key={childPath}>
                <button
                  type="button"
                  className="files-tree-item dir"
                  style={{ paddingLeft: `${depth * 0.85 + 0.35}rem` }}
                  onClick={() => toggleDir(childPath)}
                >
                  <span aria-hidden>{open ? "▾" : "▸"}</span>
                  <span>{entry.name}</span>
                </button>
                {open ? renderTree(childPath, depth + 1) : null}
              </li>
            );
          }
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

  const readOnly = !writable || truncated;

  return (
    <div className="files-page">
      <header className="files-header">
        <div>
          <h1>Files</h1>
          <p className="muted">
            Browse and edit server configs or skill package files. Platform and fixture skills are
            read-only.
          </p>
        </div>
      </header>

      <div className="files-toolbar">
        <div className="skills-tabs" role="tablist" aria-label="File target kind">
          {(
            [
              ["server", "Server"],
              ["skill", "Skill"],
              ["draft", "Draft"],
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
            {kind === "server" ? "Server" : kind === "draft" ? "Draft" : "Skill"}
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
            <option value="">Select…</option>
            {targetOptions.map((o) => (
              <option key={o.id} value={o.id}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
      </div>

      {!target ? (
        <p className="muted">Pick a target to open its file tree.</p>
      ) : (
        <div className="files-layout">
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
            {renderTree(".", 0)}
          </aside>

          <section className="files-editor-pane" aria-label="Editor">
            {loadError ? (
              <p className="error" role="alert">
                {loadError}
              </p>
            ) : null}
            {notice ? (
              <p className="muted status-inline" role="status">
                {notice}
              </p>
            ) : null}
            {!activePath ? (
              <p className="muted">Select a file to view or edit.</p>
            ) : (
              <>
                <div className="files-editor-bar">
                  <div className="files-editor-meta">
                    <code>{activePath}</code>
                    {dirty ? <span className="files-dirty">Unsaved</span> : null}
                    {source ? <span className="muted">{source}</span> : null}
                    {readOnly ? <span className="files-readonly">Read-only</span> : null}
                  </div>
                  <div className="files-editor-actions btn-row">
                    <button
                      type="button"
                      className="btn btn-ghost btn-compact"
                      disabled={!dirty || save.isPending}
                      onClick={() => {
                        setDraft(saved);
                      }}
                    >
                      Discard
                    </button>
                    <button
                      type="button"
                      className="btn btn-primary btn-compact"
                      disabled={!dirty || readOnly || save.isPending}
                      onClick={() => save.mutate()}
                    >
                      {save.isPending ? "Saving…" : "Save"}
                    </button>
                  </div>
                </div>
                {truncated ? (
                  <p className="error" role="alert">
                    File exceeds the read size limit and cannot be saved from this editor.
                  </p>
                ) : null}
                {!writable && !truncated ? (
                  <p className="muted" role="status">
                    This location is read-only
                    {source === "platform" || source === "fixture"
                      ? " (built-in skill)."
                      : "."}
                  </p>
                ) : null}
                {save.isError ? (
                  <p className="error" role="alert">
                    {(save.error as Error).message}
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
