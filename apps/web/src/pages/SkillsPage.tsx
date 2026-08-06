import { useMemo, useState } from "react";
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

type Selection =
  | { kind: "local"; name: string }
  | { kind: "catalog"; name: string }
  | { kind: "draft"; slug: string; name: string }
  | null;

function containerLabel(value?: string | null): string {
  switch (value) {
    case "full":
      return "Full Docker";
    case "partial":
      return "Partial Docker";
    case "none":
      return "Native only";
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

export function SkillsPage({ user }: { user: PublicUser }) {
  const qc = useQueryClient();
  const canPackage = can(user.role, "skills.package");
  const canBrowse = roleAtLeast(user.role, "operator");

  const [tab, setTab] = useState<TabId>("platform");
  const [selection, setSelection] = useState<Selection>(null);
  const [catalogQuery, setCatalogQuery] = useState("");
  const [catalogSearch, setCatalogSearch] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [installingSkill, setInstallingSkill] = useState<string | null>(null);
  const [pendingUninstall, setPendingUninstall] = useState<{
    name: string;
    servers: Array<{ id: string; name: string }>;
  } | null>(null);

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

  const draftSelection: SkillDraftRow | null = useMemo(() => {
    if (selection?.kind !== "draft") return null;
    return drafts.data?.drafts.find((d) => d.slug === selection.slug) ?? null;
  }, [selection, drafts.data?.drafts]);

  function flash(message: string) {
    setNotice(message);
    setError(null);
    window.setTimeout(() => setNotice(null), 4000);
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
          <p className="muted">Operators and admins can browse the skill library.</p>
        </header>
      </div>
    );
  }

  const listForTab: SkillRow[] =
    tab === "platform" ? platformSkills : tab === "installed" ? installedSkills : [];

  return (
    <div className="page stack skills-page">
      <header className="page-header">
        <h1>Skills</h1>
        <p className="muted status-inline">
          Skills are packages that teach PlayOn how to install, run, and manage a game server.
          Platform skills ship with Home; game skills install from{" "}
          <a href="https://playon.games/skills" target="_blank" rel="noreferrer">
            playon.games
          </a>{" "}
          or chat. Agents can search and install the same catalog.
        </p>
      </header>

      <div className="skills-tabs" role="tablist" aria-label="Skill library">
        {(
          [
            ["platform", "Platform", platformSkills.length],
            ["installed", "Installed", installedSkills.length],
            ["catalog", "Catalog", catalog.data?.skills?.length],
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

      <div className="skills-layout">
        <section className="panel stack tight skills-list-panel">
          {tab === "catalog" ? (
            <>
              <form
                className="btn-row"
                onSubmit={(e) => {
                  e.preventDefault();
                  setCatalogSearch(catalogQuery.trim());
                }}
              >
                <label className="field" style={{ flex: 1 }}>
                  <span>Search catalog</span>
                  <input
                    value={catalogQuery}
                    onChange={(e) => setCatalogQuery(e.target.value)}
                    placeholder="minecraft, rust, …"
                  />
                </label>
                <button className="btn" type="submit" disabled={catalog.isFetching}>
                  {catalog.isFetching ? "Searching…" : "Search"}
                </button>
              </form>
              {catalog.data?.warnings?.length ? (
                <p className="muted status-inline">
                  {catalog.data.warnings.length} catalog entr
                  {catalog.data.warnings.length === 1 ? "y" : "ies"} skipped (invalid metadata).
                </p>
              ) : null}
              {catalog.data?.error ? <p className="error">{catalog.data.error}</p> : null}
              {catalog.isLoading ? (
                <p className="muted">Loading catalog…</p>
              ) : catalog.data?.skills?.length ? (
                <ul className="list compact-list skills-select-list">
                  {catalog.data.skills.map((s) => (
                    <li key={s.name}>
                      <button
                        type="button"
                        className={
                          selection?.kind === "catalog" && selection.name === s.name
                            ? "skills-row active"
                            : "skills-row"
                        }
                        onClick={() => setSelection({ kind: "catalog", name: s.name })}
                      >
                        <strong>{s.game ?? s.name}</strong>
                        <span className="muted">
                          {s.name} · v{s.version}
                          {s.official ? " · official" : ""}
                          {s.containerSupport ? ` · ${containerLabel(s.containerSupport)}` : ""}
                          {s.installed ? " · installed" : ""}
                        </span>
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
                    Air-gapped hosts can import a local `.skill.zip`. Normal installs use the catalog
                    or chat.
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
                        setSelection({ kind: "draft", slug: d.slug, name: d.skillName })
                      }
                    >
                      <strong>{d.game ?? d.skillName}</strong>
                      <span className="muted">
                        {d.skillName} · v{d.version} · draft
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="muted status-inline">
                No drafts yet. Agents create drafts when inventing a new skill; promote them here
                when ready.
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
                      onClick={() => setSelection({ kind: "local", name: s.name })}
                    >
                      <strong>{s.game ?? s.name}</strong>
                      <span className="muted">
                        {s.name} · v{s.version}
                        {s.containerSupport ? ` · ${containerLabel(s.containerSupport)}` : ""}
                        {s.source === "server" ? " · server-scoped" : ""}
                        {s.source === "fixture" ? " · fixture" : ""}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="muted status-inline">
                {tab === "platform"
                  ? "No platform skills discovered on this host."
                  : "No game skills installed yet. Browse the Catalog tab or ask chat to install one."}
              </p>
            )
          ) : null}
        </section>

        <aside className="panel stack tight skills-detail-panel">
          {!selection ? (
            <p className="muted status-inline">Select a skill to see details and actions.</p>
          ) : null}

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
                <LocalDetail skill={detail.data.skill} />
              ) : (
                <div className="stack tight">
                  <h3>{draftSelection.game ?? draftSelection.skillName}</h3>
                  <p className="muted status-inline">{draftSelection.description}</p>
                </div>
              )}
              {canPackage ? (
                <div className="btn-row">
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
                    className="btn"
                    disabled={uninstall.isPending}
                    onClick={() => uninstall.mutate({ name: draftSelection.skillName })}
                  >
                    Discard draft
                  </button>
                </div>
              ) : null}
            </>
          ) : null}

          {selection?.kind === "local" ? (
            <>
              {detail.isLoading ? <p className="muted">Loading…</p> : null}
              {detail.isError ? (
                <p className="error">{(detail.error as Error).message}</p>
              ) : null}
              {detail.data?.skill ? (
                <>
                  <LocalDetail skill={detail.data.skill} />
                  <div className="btn-row">
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
                        className="btn"
                        disabled={uninstall.isPending}
                        onClick={() => uninstall.mutate({ name: selection.name })}
                      >
                        Uninstall
                      </button>
                    ) : null}
                  </div>
                  {detail.data.skill.source === "platform" ||
                  detail.data.skill.source === "fixture" ? (
                    <p className="muted status-inline">
                      Built-in skills cannot be uninstalled from this host.
                    </p>
                  ) : null}
                </>
              ) : null}
            </>
          ) : null}

          {pendingUninstall ? (
            <div className="stack tight" role="alertdialog" aria-label="Confirm uninstall">
              <p className="error">
                {pendingUninstall.name} is still referenced by{" "}
                {pendingUninstall.servers.length} server
                {pendingUninstall.servers.length === 1 ? "" : "s"}:{" "}
                {pendingUninstall.servers.map((s) => s.name).join(", ")}.
              </p>
              <div className="btn-row">
                <button
                  type="button"
                  className="btn"
                  onClick={() => setPendingUninstall(null)}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="btn btn-primary"
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
      <p className="muted status-inline">
        {skill.name} · v{skill.version}
        {skill.official ? " · official" : ""}
      </p>
      {skill.description ? <p>{skill.description}</p> : null}
      <dl className="skills-meta">
        <div>
          <dt>Container</dt>
          <dd>{containerLabel(skill.containerSupport)}</dd>
        </div>
        {skill.minRamMb ? (
          <div>
            <dt>Min RAM</dt>
            <dd>{skill.minRamMb} MB</dd>
          </div>
        ) : null}
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
            <a href={`https://playon.games/skills/${encodeURIComponent(skill.name)}`} target="_blank" rel="noreferrer">
              playon.games/skills/{skill.name}
            </a>
          </dd>
        </div>
      </dl>
      {canPackage ? (
        <div className="btn-row">
          <button
            type="button"
            className="btn btn-primary"
            disabled={skill.installed || installing}
            onClick={onInstall}
          >
            {skill.installed ? "Installed" : installing ? "Installing…" : "Install"}
          </button>
        </div>
      ) : (
        <p className="muted status-inline">Admins can install catalog skills on this host.</p>
      )}
    </div>
  );
}

function LocalDetail({ skill }: { skill: SkillDetail }) {
  const m = skill.metadata;
  return (
    <div className="stack tight">
      <h3>{m.game ?? m.name}</h3>
      <p className="muted status-inline">
        {m.name} · v{m.version}
      </p>
      {m.description ? <p>{m.description}</p> : null}
      <dl className="skills-meta">
        <div>
          <dt>Source</dt>
          <dd>{sourceLabel(skill.source)}</dd>
        </div>
        <div>
          <dt>Container</dt>
          <dd>{containerLabel(m.containerSupport)}</dd>
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
        {m.minRamMb ? (
          <div>
            <dt>Min RAM</dt>
            <dd>{m.minRamMb} MB</dd>
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
    </div>
  );
}
