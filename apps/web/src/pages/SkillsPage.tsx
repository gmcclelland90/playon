import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { can, roleAtLeast, type PublicUser } from "@playon/shared";
import {
  api,
  type CatalogSkillRow,
  type SkillDetail,
  type SkillDraftRow,
  type SkillRow,
} from "../api";

type TabId = "platform" | "installed" | "catalog" | "drafts";
type CatalogFilter = "all" | "official" | "available";

type Selection =
  | { kind: "local"; name: string }
  | { kind: "catalog"; name: string }
  | { kind: "draft"; slug: string; name: string }
  | null;

function containerLabel(value?: string | null): string {
  switch (value) {
    case "full":
      return "Docker";
    case "partial":
      return "Docker (partial)";
    case "none":
      return "Native";
    default:
      return value?.trim() || "—";
  }
}

function sourceLabel(source?: string): string {
  switch (source) {
    case "platform":
      return "Platform (built-in)";
    case "fixture":
      return "Lab fixture";
    case "installed":
      return "Installed on this host";
    case "draft":
      return "Agent draft";
    case "server":
      return "Per-server skill";
    default:
      return source ?? "—";
  }
}

function SkillBadges({
  official,
  installed,
  containerSupport,
  draft,
}: {
  official?: boolean;
  installed?: boolean;
  containerSupport?: string | null;
  draft?: boolean;
}) {
  return (
    <span className="skills-badges">
      {official ? <span className="skills-badge skills-badge-cyan">Official</span> : null}
      {installed ? <span className="skills-badge skills-badge-cyan">Installed</span> : null}
      {draft ? <span className="skills-badge skills-badge-rose">Draft</span> : null}
      {containerSupport ? (
        <span className="skills-badge">{containerLabel(containerSupport)}</span>
      ) : null}
    </span>
  );
}

export function SkillsPage({ user }: { user: PublicUser }) {
  const qc = useQueryClient();
  const canPackage = can(user.role, "skills.package");
  const canBrowse = roleAtLeast(user.role, "operator");

  const [tab, setTab] = useState<TabId>("installed");
  const [selection, setSelection] = useState<Selection>(null);
  const [catalogQuery, setCatalogQuery] = useState("");
  const [catalogSearch, setCatalogSearch] = useState("");
  const [catalogFilter, setCatalogFilter] = useState<CatalogFilter>("all");
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [installingSkill, setInstallingSkill] = useState<string | null>(null);
  const [pendingUninstall, setPendingUninstall] = useState<{
    name: string;
    servers: Array<{ id: string; name: string }>;
  } | null>(null);
  const [pendingRemove, setPendingRemove] = useState<{
    name: string;
    kind: "uninstall" | "discard";
  } | null>(null);
  const detailPanelRef = useRef<HTMLElement>(null);
  const defaultsApplied = useRef(false);

  const skills = useQuery({
    queryKey: ["skills"],
    queryFn: () => api.skills(),
    enabled: canBrowse,
  });

  const drafts = useQuery({
    queryKey: ["skill-drafts"],
    queryFn: () => api.skillDrafts(),
    enabled: canBrowse,
  });

  const catalog = useQuery({
    queryKey: ["skills-catalog", catalogSearch],
    queryFn: () => api.skillsCatalog(catalogSearch),
    enabled: canBrowse,
  });

  const detailName =
    selection?.kind === "local" || selection?.kind === "draft" ? selection.name : null;

  const detail = useQuery({
    queryKey: ["skill-detail", detailName],
    queryFn: () => api.skillDetail(detailName!),
    enabled: Boolean(detailName),
  });

  const platformSkills = useMemo(
    () =>
      (skills.data?.skills ?? []).filter(
        (s) => s.source === "platform" || s.source === "fixture",
      ),
    [skills.data?.skills],
  );

  const installedSkills = useMemo(
    () =>
      (skills.data?.skills ?? []).filter(
        (s) => s.source === "installed" || s.source === "server",
      ),
    [skills.data?.skills],
  );

  const catalogSelection: CatalogSkillRow | null = useMemo(() => {
    if (selection?.kind !== "catalog") return null;
    return catalog.data?.skills.find((s) => s.name === selection.name) ?? null;
  }, [selection, catalog.data?.skills]);

  const filteredCatalog = useMemo(() => {
    const rows = catalog.data?.skills ?? [];
    if (catalogFilter === "official") return rows.filter((s) => s.official);
    if (catalogFilter === "available") return rows.filter((s) => !s.installed);
    return rows;
  }, [catalog.data?.skills, catalogFilter]);

  const draftSelection: SkillDraftRow | null = useMemo(() => {
    if (selection?.kind !== "draft") return null;
    return drafts.data?.drafts.find((d) => d.slug === selection.slug) ?? null;
  }, [selection, drafts.data?.drafts]);

  useEffect(() => {
    if (defaultsApplied.current || skills.isLoading) return;
    defaultsApplied.current = true;
    if (installedSkills.length > 0) setTab("installed");
    else setTab("catalog");
  }, [skills.isLoading, installedSkills.length]);

  useEffect(() => {
    if (!selection) return;
    detailPanelRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [selection]);

  useEffect(() => {
    if (tab !== "catalog") return;
    const handle = window.setTimeout(() => {
      setCatalogSearch(catalogQuery.trim());
    }, 350);
    return () => window.clearTimeout(handle);
  }, [catalogQuery, tab]);

  function flash(message: string) {
    setNotice(message);
    setError(null);
    window.setTimeout(() => setNotice(null), 4000);
  }

  function selectSkill(next: Selection) {
    setSelection(next);
    setPendingRemove(null);
    setPendingUninstall(null);
    setError(null);
  }

  const installFromCatalog = useMutation({
    mutationFn: (name: string) => api.installSkillFromCatalog({ name }),
    onMutate: (name) => {
      setInstallingSkill(name);
      setError(null);
    },
    onSuccess: async (result) => {
      flash(`Installed ${result.skill.skillName} v${result.skill.version}`);
      await qc.invalidateQueries({ queryKey: ["skills-catalog"] });
      await qc.invalidateQueries({ queryKey: ["skills"] });
    },
    onError: (err: Error) => setError(err.message),
    onSettled: () => setInstallingSkill(null),
  });

  const promoteDraft = useMutation({
    mutationFn: (slug: string) => api.promoteSkillDraft(slug),
    onSuccess: async (result) => {
      flash(`Promoted ${result.skill.skillName}`);
      setSelection(null);
      await qc.invalidateQueries({ queryKey: ["skill-drafts"] });
      await qc.invalidateQueries({ queryKey: ["skills"] });
    },
    onError: (err: Error) => setError(err.message),
  });

  const uninstall = useMutation({
    mutationFn: ({ name, force }: { name: string; force?: boolean }) =>
      api.uninstallSkill(name, force),
    onSuccess: async (result) => {
      flash(`Uninstalled ${result.skill.skillName}`);
      setPendingUninstall(null);
      setSelection(null);
      await qc.invalidateQueries({ queryKey: ["skills"] });
      await qc.invalidateQueries({ queryKey: ["skills-catalog"] });
      await qc.invalidateQueries({ queryKey: ["skill-drafts"] });
    },
    onError: (err: Error & { servers?: Array<{ id: string; name: string }> }, vars) => {
      if (err.message === "skill_in_use") {
        setPendingUninstall({ name: vars.name, servers: err.servers ?? [] });
        return;
      }
      setError(err.message);
    },
  });

  if (!canBrowse) {
    return (
      <div className="page stack">
        <header className="page-header">
          <h1>Skills</h1>
          <p className="muted">Operators and admins can browse the package library.</p>
        </header>
      </div>
    );
  }

  const listForTab: SkillRow[] =
    tab === "platform" ? platformSkills : tab === "installed" ? installedSkills : [];

  return (
    <div className="page stack skills-page">
      <header className="page-header">
        <h1>Games & Platform Packages</h1>
        <p className="lede">
          Teach this host how to run a game — install from the catalog, then create the server on the
          Map.
        </p>
      </header>

      <div className="skills-tabs" role="tablist" aria-label="Package library">
        {(
          [
            ["installed", "Installed", installedSkills.length],
            ["catalog", "Games", catalog.data?.skills?.length],
            ["platform", "Platform", platformSkills.length],
            ["drafts", "Drafts", drafts.data?.drafts?.length],
          ] as const
        ).map(([id, label, count]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            className={tab === id ? "active" : undefined}
            onClick={() => {
              setTab(id);
              setSelection(null);
              setPendingUninstall(null);
              setPendingRemove(null);
              setError(null);
            }}
          >
            {label}
            {typeof count === "number" ? <span className="muted"> {count}</span> : null}
          </button>
        ))}
      </div>

      {notice ? (
        <p className="ok" role="status">
          {notice}
        </p>
      ) : null}
      {error ? (
        <p className="error" role="alert">
          {error}
        </p>
      ) : null}

      <div className={`skills-layout${selection ? " has-selection" : ""}`}>
        <section className="panel stack tight skills-list-panel">
          {tab === "catalog" ? (
            <>
              <form
                className="skills-search"
                onSubmit={(e) => {
                  e.preventDefault();
                  setCatalogSearch(catalogQuery.trim());
                }}
              >
                <label className="skills-search-field">
                    <span className="sr-only">Search catalog</span>
                  <input
                    value={catalogQuery}
                    onChange={(e) => {
                      const v = e.target.value;
                      setCatalogQuery(v);
                    }}
                    onBlur={() => setCatalogSearch(catalogQuery.trim())}
                    placeholder="Search games — minecraft, rust…"
                    autoComplete="off"
                  />
                </label>
                <button className="btn btn-compact" type="submit" disabled={catalog.isFetching}>
                  {catalog.isFetching ? "…" : "Search"}
                </button>
                {catalogSearch ? (
                  <button
                    className="btn btn-ghost btn-compact"
                    type="button"
                    onClick={() => {
                      setCatalogQuery("");
                      setCatalogSearch("");
                    }}
                  >
                    Clear
                  </button>
                ) : null}
              </form>
              <div className="skills-filter-row" role="group" aria-label="Catalog filters">
                {(
                  [
                    ["all", "All"],
                    ["official", "Official"],
                    ["available", "Not installed"],
                  ] as const
                ).map(([id, label]) => (
                  <button
                    key={id}
                    type="button"
                    className={catalogFilter === id ? "skills-filter active" : "skills-filter"}
                    onClick={() => setCatalogFilter(id)}
                  >
                    {label}
                  </button>
                ))}
              </div>
              {catalog.data?.warnings?.length ? (
                <p className="muted status-inline">
                  {catalog.data.warnings.length} catalog entr
                  {catalog.data.warnings.length === 1 ? "y" : "ies"} skipped (invalid metadata).
                </p>
              ) : null}
              {catalog.data?.error ? <p className="error">{catalog.data.error}</p> : null}
              {catalog.isLoading ? (
                <p className="muted">Loading catalog…</p>
              ) : filteredCatalog.length ? (
                <ul className="list compact-list skills-select-list">
                  {filteredCatalog.map((s) => (
                    <li key={s.name}>
                      <button
                        type="button"
                        className={
                          selection?.kind === "catalog" && selection.name === s.name
                            ? "skills-row active"
                            : "skills-row"
                        }
                        onClick={() => selectSkill({ kind: "catalog", name: s.name })}
                      >
                        <strong>{s.game ?? s.name}</strong>
                        <SkillBadges
                          official={s.official}
                          installed={s.installed}
                        />
                        <span className="muted small">v{s.version}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              ) : catalog.isSuccess && !catalog.data?.error ? (
                <p className="muted status-inline">No matching skills in the catalog.</p>
              ) : null}

              {canPackage ? (
                <details className="confirm-always-details">
                  <summary>Advanced — offline / custom package</summary>
                  <p className="muted status-inline">
                    Air-gapped hosts can import a local `.skill.zip`. Normal installs use the Games
                    tab or chat.
                  </p>
                  <label className="field">
                    <span>Import package file</span>
                    <input
                      type="file"
                      accept=".zip,application/zip"
                      onChange={(e) => {
                        const file = e.target.files?.[0];
                        if (!file) return;
                        setError(null);
                        void api
                          .importSkill(file)
                          .then(async (result) => {
                            flash(
                              `Imported ${result.skill.skillName} v${result.skill.version}`,
                            );
                            e.target.value = "";
                            await qc.invalidateQueries({ queryKey: ["skills"] });
                            await qc.invalidateQueries({ queryKey: ["skills-catalog"] });
                          })
                          .catch((err: Error) => setError(err.message));
                      }}
                    />
                  </label>
                </details>
              ) : null}
            </>
          ) : null}

          {tab === "drafts" ? (
            drafts.isLoading ? (
              <p className="muted">Loading drafts…</p>
            ) : drafts.data?.drafts?.length ? (
              <ul className="list compact-list skills-select-list">
                {drafts.data.drafts.map((d) => (
                  <li key={d.slug}>
                    <button
                      type="button"
                      className={
                        selection?.kind === "draft" && selection.slug === d.slug
                          ? "skills-row active"
                          : "skills-row"
                      }
                      onClick={() =>
                        selectSkill({ kind: "draft", slug: d.slug, name: d.skillName })
                      }
                    >
                      <strong>{d.game ?? d.skillName}</strong>
                      <SkillBadges draft containerSupport={null} />
                      <span className="muted small">v{d.version}</span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="muted status-inline">
                No drafts yet. Agents create drafts when inventing a new Game or Platform package;
                promote them here when ready.
              </p>
            )
          ) : null}

          {tab === "platform" || tab === "installed" ? (
            skills.isLoading ? (
              <p className="muted">Loading skills…</p>
            ) : listForTab.length ? (
              <ul className="list compact-list skills-select-list">
                {listForTab.map((s) => (
                  <li key={s.id}>
                    <button
                      type="button"
                      className={
                        selection?.kind === "local" && selection.name === s.name
                          ? "skills-row active"
                          : "skills-row"
                      }
                      onClick={() => selectSkill({ kind: "local", name: s.name })}
                    >
                      <strong>{s.game ?? s.name}</strong>
                      <SkillBadges
                        installed={
                          tab !== "installed" &&
                          (s.source === "installed" || s.source === "server")
                        }
                      />
                      <span className="muted small">
                        v{s.version}
                        {s.source === "server" ? " · server-scoped" : ""}
                        {s.source === "fixture" ? " · fixture" : ""}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <div className="empty-hint">
                <strong>{tab === "platform" ? "No platform packages" : "Nothing installed yet"}</strong>
                <p className="muted status-inline">
                  {tab === "platform" ? (
                    "Platform packages ship with Home and appear here when the host is ready."
                  ) : (
                    <>
                      Open the{" "}
                      <button
                        type="button"
                        className="linkish"
                        onClick={() => {
                          setTab("catalog");
                          setSelection(null);
                        }}
                      >
                        Games
                      </button>{" "}
                      or ask on the Map to install a Game package.
                    </>
                  )}
                </p>
              </div>
            )
          ) : null}
        </section>

        <aside
          ref={detailPanelRef}
          className="panel stack tight skills-detail-panel"
          aria-live="polite"
        >
          {!selection ? (
            <div className="empty-hint">
              <strong>
                {tab === "catalog"
                  ? "Find tonight’s game"
                  : tab === "installed"
                    ? "Pick a package"
                    : tab === "drafts"
                      ? "Review a draft"
                      : "Platform packages"}
              </strong>
              <p className="muted status-inline">
                {tab === "catalog"
                  ? "Search or select a game on the left. Install puts it on this host; create the server on the Map."
                  : tab === "installed"
                    ? "Installed packages power servers on this host. Add more from the Games tab."
                    : tab === "drafts"
                      ? "Agent-invented packages land here until you promote them."
                      : "Built-in Home platform packages. They cannot be uninstalled."}
              </p>
              {tab === "installed" ? (
                <button
                  type="button"
                  className="btn btn-primary btn-compact"
                  onClick={() => {
                    setTab("catalog");
                    setSelection(null);
                  }}
                >
                  Browse games
                </button>
              ) : null}
            </div>
          ) : (
            <div className="skills-detail-toolbar">
              <button
                type="button"
                className="btn btn-ghost btn-compact"
                onClick={() => setSelection(null)}
              >
                Clear selection
              </button>
            </div>
          )}

          {selection?.kind === "catalog" && catalogSelection ? (
            <CatalogDetail
              skill={catalogSelection}
              canPackage={canPackage}
              installing={installingSkill === catalogSelection.name}
              onInstall={() => installFromCatalog.mutate(catalogSelection.name)}
            />
          ) : null}

          {selection?.kind === "draft" && draftSelection ? (
            <>
              {detail.isLoading ? <p className="muted">Loading…</p> : null}
              {detail.data?.skill ? (
                <LocalDetail
                  skill={detail.data.skill}
                  actions={
                    canPackage ? (
                      <div className="btn-row skills-detail-actions">
                        <button
                          type="button"
                          className="btn btn-primary"
                          disabled={promoteDraft.isPending}
                          onClick={() => promoteDraft.mutate(draftSelection.slug)}
                        >
                          {promoteDraft.isPending ? "Promoting…" : "Promote to library"}
                        </button>
                        <button
                          type="button"
                          className="btn btn-danger"
                          disabled={uninstall.isPending}
                          onClick={() =>
                            setPendingRemove({
                              name: draftSelection.skillName,
                              kind: "discard",
                            })
                          }
                        >
                          Discard draft
                        </button>
                      </div>
                    ) : null
                  }
                />
              ) : (
                <div className="stack tight">
                  <h3>{draftSelection.game ?? draftSelection.skillName}</h3>
                  <p className="muted status-inline">{draftSelection.description}</p>
                  {canPackage ? (
                    <div className="btn-row skills-detail-actions">
                      <button
                        type="button"
                        className="btn btn-primary"
                        disabled={promoteDraft.isPending}
                        onClick={() => promoteDraft.mutate(draftSelection.slug)}
                      >
                        {promoteDraft.isPending ? "Promoting…" : "Promote to library"}
                      </button>
                      <button
                        type="button"
                        className="btn btn-danger"
                        disabled={uninstall.isPending}
                        onClick={() =>
                          setPendingRemove({
                            name: draftSelection.skillName,
                            kind: "discard",
                          })
                        }
                      >
                        Discard draft
                      </button>
                    </div>
                  ) : null}
                </div>
              )}
            </>
          ) : null}

          {selection?.kind === "local" ? (
            <>
              {detail.isLoading ? <p className="muted">Loading…</p> : null}
              {detail.isError ? (
                <p className="error">{(detail.error as Error).message}</p>
              ) : null}
              {detail.data?.skill ? (
                <LocalDetail
                  skill={detail.data.skill}
                  actions={
                    <div className="btn-row skills-detail-actions">
                      {detail.data.skill.source === "installed" ||
                      detail.data.skill.source === "server" ? (
                        <Link className="btn btn-primary" to="/">
                          Create on Map
                        </Link>
                      ) : null}
                      {canPackage ? (
                        <button
                          type="button"
                          className="btn"
                          onClick={() => {
                            void api.exportSkill(selection.name).catch((err: Error) => {
                              setError(err.message);
                            });
                          }}
                        >
                          Export zip
                        </button>
                      ) : null}
                      {canPackage &&
                      (detail.data.skill.source === "installed" ||
                        detail.data.skill.source === "draft") ? (
                        <button
                          type="button"
                          className="btn btn-danger"
                          disabled={uninstall.isPending}
                          onClick={() =>
                            setPendingRemove({ name: selection.name, kind: "uninstall" })
                          }
                        >
                          Uninstall
                        </button>
                      ) : null}
                    </div>
                  }
                />
              ) : null}
            </>
          ) : null}

          {pendingRemove && !pendingUninstall ? (
            <div className="confirm-banner stack tight" role="alertdialog" aria-label="Confirm remove">
              <p className="status-inline">
                {pendingRemove.kind === "discard"
                  ? `Discard draft “${pendingRemove.name}”? This cannot be undone.`
                  : `Uninstall “${pendingRemove.name}” from this host?`}
              </p>
              <div className="btn-row">
                <button
                  type="button"
                  className="btn btn-danger"
                  disabled={uninstall.isPending}
                  onClick={() => {
                    uninstall.mutate({ name: pendingRemove.name });
                    setPendingRemove(null);
                  }}
                >
                  {pendingRemove.kind === "discard" ? "Discard" : "Uninstall"}
                </button>
                <button
                  type="button"
                  className="btn btn-ghost"
                  disabled={uninstall.isPending}
                  onClick={() => setPendingRemove(null)}
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : null}

          {pendingUninstall ? (
            <div className="confirm-banner stack tight" role="alertdialog" aria-label="Confirm force uninstall">
              <p className="error">
                {pendingUninstall.name} is still referenced by{" "}
                {pendingUninstall.servers.length} server
                {pendingUninstall.servers.length === 1 ? "" : "s"}:{" "}
                {pendingUninstall.servers.map((s) => s.name).join(", ")}.
              </p>
              <div className="btn-row">
                <button
                  type="button"
                  className="btn btn-ghost"
                  onClick={() => setPendingUninstall(null)}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="btn btn-danger"
                  disabled={uninstall.isPending}
                  onClick={() =>
                    uninstall.mutate({ name: pendingUninstall.name, force: true })
                  }
                >
                  Uninstall anyway
                </button>
              </div>
            </div>
          ) : null}
        </aside>
      </div>
    </div>
  );
}

function CatalogDetail({
  skill,
  canPackage,
  installing,
  onInstall,
}: {
  skill: CatalogSkillRow;
  canPackage: boolean;
  installing: boolean;
  onInstall: () => void;
}) {
  return (
    <div className="stack tight">
      <h3>{skill.game ?? skill.name}</h3>
      <SkillBadges official={skill.official} installed={skill.installed} />
      <p className="muted status-inline">
        v{skill.version} · {containerLabel(skill.containerSupport)}
        {skill.minRamMb ? ` · ${skill.minRamMb} MB min` : ""}
      </p>
      {skill.description ? <p>{skill.description}</p> : null}
      {canPackage ? (
        <div className="btn-row skills-detail-actions">
          {skill.installed ? (
            <Link className="btn btn-primary" to="/">
              Create on Map
            </Link>
          ) : (
            <button
              type="button"
              className="btn btn-primary"
              disabled={installing}
              onClick={onInstall}
            >
              {installing ? "Installing…" : "Install"}
            </button>
          )}
        </div>
      ) : (
        <p className="muted status-inline">Admins can install catalog packages on this host.</p>
      )}
      <details className="skills-advanced-meta">
        <summary className="muted small">More about this package</summary>
        <dl className="skills-meta">
          <div>
            <dt>Package id</dt>
            <dd>
              <code>{skill.name}</code>
            </dd>
          </div>
          {skill.tags?.length ? (
            <div>
              <dt>Tags</dt>
              <dd>{skill.tags.join(", ")}</dd>
            </div>
          ) : null}
          {skill.dependencies?.length ? (
            <div>
              <dt>Dependencies</dt>
              <dd>{skill.dependencies.join(", ")}</dd>
            </div>
          ) : null}
          <div>
            <dt>Catalog</dt>
            <dd>
              <a
                href={`https://playon.games/packages/${encodeURIComponent(skill.name)}`}
                target="_blank"
                rel="noreferrer"
              >
                playon.games/packages/{skill.name}
              </a>
            </dd>
          </div>
        </dl>
      </details>
    </div>
  );
}

function LocalDetail({
  skill,
  actions,
}: {
  skill: SkillDetail;
  actions?: ReactNode;
}) {
  const m = skill.metadata;
  return (
    <div className="stack tight">
      <h3>{m.game ?? m.name}</h3>
      <SkillBadges
        installed={skill.source === "installed" || skill.source === "server"}
      />
      <p className="muted status-inline">
        v{m.version} · {containerLabel(m.containerSupport)}
        {m.minRamMb ? ` · ${m.minRamMb} MB min` : ""}
      </p>
      {m.description ? <p>{m.description}</p> : null}
      {actions}
      {skill.source === "platform" || skill.source === "fixture" ? (
        <p className="muted status-inline">Built-in platform package — cannot be uninstalled from this host.</p>
      ) : null}
      <details className="skills-advanced-meta">
        <summary className="muted small">More about this package</summary>
        <dl className="skills-meta">
          <div>
            <dt>Source</dt>
            <dd>{sourceLabel(skill.source)}</dd>
          </div>
          <div>
            <dt>Package id</dt>
            <dd>
              <code>{m.name}</code>
            </dd>
          </div>
          {m.dockerImage ? (
            <div>
              <dt>Docker image</dt>
              <dd>
                <code>{m.dockerImage}</code>
              </dd>
            </div>
          ) : null}
          {m.os?.length ? (
            <div>
              <dt>OS</dt>
              <dd>{m.os.join(", ")}</dd>
            </div>
          ) : null}
          {m.arch?.length ? (
            <div>
              <dt>Arch</dt>
              <dd>{m.arch.join(", ")}</dd>
            </div>
          ) : null}
          {m.adminDialect ? (
            <div>
              <dt>Admin</dt>
              <dd>{m.adminDialect}</dd>
            </div>
          ) : null}
          {m.queryDialect ? (
            <div>
              <dt>Query</dt>
              <dd>{m.queryDialect}</dd>
            </div>
          ) : null}
          {m.ports?.length ? (
            <div>
              <dt>Ports</dt>
              <dd>
                {m.ports
                  .map(
                    (p) =>
                      `${p.name}${p.default ? ` ${p.default}` : ""}${p.protocol ? `/${p.protocol}` : ""}`,
                  )
                  .join(", ")}
              </dd>
            </div>
          ) : null}
          {m.requiredTools?.length ? (
            <div>
              <dt>Tools</dt>
              <dd>{m.requiredTools.join(", ")}</dd>
            </div>
          ) : null}
          {m.tags?.length ? (
            <div>
              <dt>Tags</dt>
              <dd>{m.tags.join(", ")}</dd>
            </div>
          ) : null}
          {skill.dependencies.length ? (
            <div>
              <dt>Dependencies</dt>
              <dd>
                {skill.dependencies.map((d) => (
                  <span key={d.name} className={d.present ? undefined : "error"}>
                    {d.name}
                    {d.present ? "" : " (missing)"}
                    {"; "}
                  </span>
                ))}
              </dd>
            </div>
          ) : null}
          {m.join?.clientSetupNotes ? (
            <div>
              <dt>Join notes</dt>
              <dd>{m.join.clientSetupNotes}</dd>
            </div>
          ) : null}
          <div>
            <dt>Path</dt>
            <dd>
              <code>{skill.path}</code>
            </dd>
          </div>
        </dl>
      </details>
    </div>
  );
}
