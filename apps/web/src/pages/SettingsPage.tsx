import { useEffect, useMemo, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  can,
  getLlmPreset,
  LLM_PRESET_LIST,
  type LlmPresetId,
  type PublicUser,
} from "@playon/shared";
import { api } from "../api";


export function SettingsPage({ user }: { user: PublicUser }) {
  const qc = useQueryClient();
  const llm = useQuery({ queryKey: ["llm"], queryFn: api.getLlmSettings });
  const [preset, setPreset] = useState<LlmPresetId>("venice");
  const [baseUrl, setBaseUrl] = useState("");
  const [model, setModel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [saved, setSaved] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<{
    baseUrl?: string;
    model?: string;
    apiKey?: string;
  }>({});
  const activePreset = getLlmPreset(preset);

  const [newUsername, setNewUsername] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [newRole, setNewRole] = useState<"admin" | "operator">("operator");
  const [userCreated, setUserCreated] = useState<string | null>(null);
  const [backupRoot, setBackupRoot] = useState("");
  const [backupSaved, setBackupSaved] = useState(false);
  const [skillNotice, setSkillNotice] = useState<string | null>(null);
  const [skillError, setSkillError] = useState<string | null>(null);
  const [catalogQuery, setCatalogQuery] = useState("");
  const [catalogSearch, setCatalogSearch] = useState("");
  const [installingSkill, setInstallingSkill] = useState<string | null>(null);

  const [addKind, setAddKind] = useState<"lan" | "cloud">("lan");
  const [addHost, setAddHost] = useState("");
  const [addUser, setAddUser] = useState("root");
  const [addPassword, setAddPassword] = useState("");
  const [addNodeName, setAddNodeName] = useState("");
  const [oneLiner, setOneLiner] = useState<string | null>(null);
  const [nodeNotice, setNodeNotice] = useState<string | null>(null);
  const [nodeError, setNodeError] = useState<string | null>(null);

  const backupTarget = useQuery({
    queryKey: ["backup-target"],
    queryFn: api.backupTarget,
  });

  const nodeSettings = useQuery({
    queryKey: ["node-settings"],
    queryFn: api.getNodeSettings,
    enabled: can(user.role, "settings.llm"),
  });

  const nodesList = useQuery({
    queryKey: ["nodes"],
    queryFn: api.nodes,
    refetchInterval: 10_000,
  });

  const saveNodeSettings = useMutation({
    mutationFn: (localComputeEnabled: boolean) => api.putNodeSettings({ localComputeEnabled }),
    onSuccess: async () => {
      setNodeNotice("Node settings saved.");
      await qc.invalidateQueries({ queryKey: ["node-settings"] });
      await qc.invalidateQueries({ queryKey: ["nodes"] });
      window.setTimeout(() => setNodeNotice(null), 3000);
    },
    onError: (err: Error) => setNodeError(err.message),
  });

  const addNodeMut = useMutation({
    mutationFn: () =>
      api.addNode({
        kind: addKind,
        host: addHost.trim(),
        username: addUser.trim(),
        password: addPassword || undefined,
        nodeName: addNodeName.trim() || undefined,
      }),
    onSuccess: async (res) => {
      setNodeNotice(`Added ${res.node.name} (${res.node.kind}) — ${res.node.detail}`);
      setAddPassword("");
      await qc.invalidateQueries({ queryKey: ["nodes"] });
    },
    onError: (err: Error) => setNodeError(err.message),
  });

  const bootstrapTokenMut = useMutation({
    mutationFn: () =>
      api.createNodeBootstrapToken({
        kind: addKind,
        nodeName: addNodeName.trim() || undefined,
        endpointHost: addKind === "cloud" ? addHost.trim() : undefined,
      }),
    onSuccess: (res) => {
      setOneLiner(res.oneLiner);
      setNodeNotice(`One-liner ready (expires ${new Date(res.expiresAt).toLocaleString()})`);
    },
    onError: (err: Error) => setNodeError(err.message),
  });

  const removeNodeMut = useMutation({
    mutationFn: (id: string) => api.removeNode(id),
    onSuccess: async () => {
      setNodeNotice("Node removed.");
      await qc.invalidateQueries({ queryKey: ["nodes"] });
    },
    onError: (err: Error) => setNodeError(err.message),
  });

  const catalog = useQuery({
    queryKey: ["skills-catalog", catalogSearch],
    queryFn: () => api.skillsCatalog(catalogSearch),
    enabled: can(user.role, "skills.package"),
  });

  const installFromCatalog = useMutation({
    mutationFn: (name: string) => api.installSkillFromCatalog({ name }),
    onMutate: (name) => {
      setInstallingSkill(name);
      setSkillNotice(null);
      setSkillError(null);
    },
    onSuccess: async (result) => {
      setSkillNotice(`Installed ${result.skill.skillName} v${result.skill.version}`);
      await qc.invalidateQueries({ queryKey: ["skills-catalog"] });
      await qc.invalidateQueries({ queryKey: ["skills"] });
      window.setTimeout(() => setSkillNotice(null), 4000);
    },
    onError: (err: Error) => setSkillError(err.message),
    onSettled: () => setInstallingSkill(null),
  });

  useEffect(() => {
    if (!llm.data?.llm) return;
    const loadedPreset = llm.data.llm.preset;
    setPreset(loadedPreset);
    const def = getLlmPreset(loadedPreset);
    setBaseUrl(llm.data.llm.baseUrl ?? def.baseUrl);
    setModel(llm.data.llm.model ?? def.defaultModel);
  }, [llm.data]);

  const dirty = useMemo(() => {
    const loaded = llm.data?.llm;
    if (!loaded) return false;
    return (
      preset !== loaded.preset ||
      baseUrl !== (loaded.baseUrl ?? getLlmPreset(loaded.preset).baseUrl) ||
      model !== (loaded.model ?? "") ||
      apiKey !== ""
    );
  }, [llm.data, preset, baseUrl, model, apiKey]);

  useEffect(() => {
    if (!dirty) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [dirty]);

  useEffect(() => {
    if (backupTarget.data?.target?.rootPath) {
      setBackupRoot(backupTarget.data.target.rootPath);
    }
  }, [backupTarget.data]);

  const save = useMutation({
    mutationFn: () =>
      api.putLlmSettings({
        preset,
        baseUrl: baseUrl || undefined,
        model: model || undefined,
        apiKey: apiKey || undefined,
      }),
    onSuccess: async () => {
      setApiKey("");
      setFieldErrors({});
      setSaved(true);
      await qc.invalidateQueries({ queryKey: ["llm"] });
      window.setTimeout(() => setSaved(false), 4000);
    },
  });

  function onPresetChange(next: LlmPresetId) {
    setPreset(next);
    const def = getLlmPreset(next);
    setBaseUrl(def.baseUrl);
    setModel(def.defaultModel);
    setFieldErrors({});
  }

  const saveBackup = useMutation({
    mutationFn: () => api.setBackupTarget(backupRoot),
    onSuccess: async () => {
      setBackupSaved(true);
      await qc.invalidateQueries({ queryKey: ["backup-target"] });
      window.setTimeout(() => setBackupSaved(false), 2000);
    },
  });

  const createUser = useMutation({
    mutationFn: () =>
      api.createUser({
        username: newUsername,
        password: newPassword,
        role: newRole,
      }),
    onSuccess: (data) => {
      setNewUsername("");
      setNewPassword("");
      setUserCreated(`${data.user.username} (${data.user.role})`);
      window.setTimeout(() => setUserCreated(null), 4000);
    },
  });

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    const errors: { baseUrl?: string; model?: string; apiKey?: string } = {};
    if (activePreset.baseUrlEditable && !baseUrl.trim()) {
      errors.baseUrl = "Base URL is required";
    }
    if (!model.trim()) errors.model = "Model is required";
    if (activePreset.requiresApiKey && !llm.data?.llm.hasApiKey && !apiKey.trim()) {
      errors.apiKey = `API key required for ${activePreset.label}`;
    }
    if (Object.keys(errors).length) {
      setFieldErrors(errors);
      return;
    }
    setFieldErrors({});
    save.mutate();
  }

  function onCreateUser(e: FormEvent) {
    e.preventDefault();
    const roleLabel = newRole === "admin" ? "Admin" : "Operator";
    if (!window.confirm(`Create account "${newUsername}" as ${roleLabel}?`)) return;
    createUser.mutate();
  }

  return (
    <div className="pane settings-page stack">
      <header className="page-header">
        <h2>Settings</h2>
        <p className="lede">
          Same tools whether you use a cloud LLM, Ollama, or MCP — only the brain and how you
          connect change.
        </p>
      </header>

      <section className="panel stack tight">
        <h3>Nodes</h3>
        <p className="muted status-inline">
          Home is the control plane. Optionally host games here, or add LAN / cloud machines via SSH
          (cloud nodes get WireGuard + a LAN join gateway).
        </p>
        <label className="field" style={{ flexDirection: "row", alignItems: "center", gap: "0.5rem" }}>
          <input
            type="checkbox"
            checked={nodeSettings.data?.nodes.localComputeEnabled ?? true}
            onChange={(e) => {
              setNodeError(null);
              saveNodeSettings.mutate(e.target.checked);
            }}
            disabled={saveNodeSettings.isPending || nodeSettings.isLoading}
          />
          <span>Also host game servers on this machine (Local)</span>
        </label>
        {nodesList.data?.wireguardTools === false ? (
          <p className="muted status-inline">
            WireGuard tools not detected on Home — install wireguard-tools (Linux) or WireGuard for
            Windows before adding cloud nodes.
          </p>
        ) : null}

        <h4>Add node</h4>
        <div className="stack tight">
          <label className="field">
            <span>Where is this machine?</span>
            <select
              value={addKind}
              onChange={(e) => setAddKind(e.target.value as "lan" | "cloud")}
            >
              <option value="lan">On my LAN (no tunnel)</option>
              <option value="cloud">In the cloud (WireGuard)</option>
            </select>
          </label>
          <label className="field">
            <span>{addKind === "cloud" ? "Public IP / hostname" : "SSH host"}</span>
            <input
              value={addHost}
              onChange={(e) => setAddHost(e.target.value)}
              placeholder={addKind === "cloud" ? "203.0.113.9" : "192.168.1.50"}
            />
          </label>
          <label className="field">
            <span>SSH username</span>
            <input value={addUser} onChange={(e) => setAddUser(e.target.value)} />
          </label>
          <label className="field">
            <span>SSH password (for Add via SSH)</span>
            <input
              type="password"
              value={addPassword}
              onChange={(e) => setAddPassword(e.target.value)}
              autoComplete="off"
            />
          </label>
          <label className="field">
            <span>Node name (optional)</span>
            <input
              value={addNodeName}
              onChange={(e) => setAddNodeName(e.target.value)}
              placeholder="spare-pc"
            />
          </label>
          <div className="btn-row">
            <button
              className="btn btn-primary"
              type="button"
              disabled={addNodeMut.isPending || !addHost.trim()}
              onClick={() => {
                setNodeError(null);
                addNodeMut.mutate();
              }}
            >
              {addNodeMut.isPending ? "Adding…" : "Add via SSH"}
            </button>
            <button
              className="btn"
              type="button"
              disabled={bootstrapTokenMut.isPending || (addKind === "cloud" && !addHost.trim())}
              onClick={() => {
                setNodeError(null);
                bootstrapTokenMut.mutate();
              }}
            >
              {bootstrapTokenMut.isPending ? "…" : "Copy one-liner instead"}
            </button>
          </div>
          {oneLiner ? (
            <label className="field">
              <span>Run on the target machine</span>
              <textarea readOnly rows={3} value={oneLiner} />
            </label>
          ) : null}
        </div>

        {nodesList.data?.nodes?.length ? (
          <ul className="list compact-list">
            {nodesList.data.nodes.map((n) => (
              <li key={n.id}>
                <div className="btn-row" style={{ justifyContent: "space-between" }}>
                  <div>
                    <strong>{n.name}</strong>{" "}
                    <span className="muted">{n.badge ?? n.kind}</span>
                    <div className="muted">
                      {n.status}
                      {n.tunnelStatus && n.tunnelStatus !== "none"
                        ? ` · tunnel ${n.tunnelStatus}`
                        : ""}
                    </div>
                  </div>
                  {n.id !== "local" ? (
                    <button
                      className="btn"
                      type="button"
                      disabled={removeNodeMut.isPending}
                      onClick={() => {
                        if (!window.confirm(`Remove node ${n.name}? Servers must be moved first.`)) {
                          return;
                        }
                        setNodeError(null);
                        removeNodeMut.mutate(n.id);
                      }}
                    >
                      Remove
                    </button>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        ) : null}
        {nodeNotice ? <p className="ok">{nodeNotice}</p> : null}
        {nodeError ? <p className="error">{nodeError}</p> : null}
      </section>

      <form className="panel stack tight" onSubmit={onSubmit}>
        <h3>In-app agents (LLM provider)</h3>
        {llm.isLoading ? (
          <div className="skeleton" aria-hidden>
            <div className="skeleton-row" />
            <div className="skeleton-row compact" />
          </div>
        ) : (
          <div className="stack tight">
            <label className="field">
              <span>Provider</span>
              <select
                value={preset}
                onChange={(e) => onPresetChange(e.target.value as LlmPresetId)}
              >
                {LLM_PRESET_LIST.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label}
                  </option>
                ))}
              </select>
            </label>

            <label className="field">
              <span>Base URL</span>
              <input
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
                placeholder={activePreset.baseUrl || "https://api.example.com/v1"}
                readOnly={!activePreset.baseUrlEditable}
                disabled={!activePreset.baseUrlEditable}
                aria-invalid={Boolean(fieldErrors.baseUrl) || undefined}
              />
              {fieldErrors.baseUrl ? (
                <span className="field-error">{fieldErrors.baseUrl}</span>
              ) : null}
            </label>
            <label className="field">
              <span>Model</span>
              <input
                value={model}
                onChange={(e) => setModel(e.target.value)}
                list="llm-model-suggestions"
                placeholder={activePreset.defaultModel || "model-id"}
                required
                aria-invalid={Boolean(fieldErrors.model) || undefined}
              />
              {activePreset.suggestedModels.length > 0 ? (
                <datalist id="llm-model-suggestions">
                  {activePreset.suggestedModels.map((id) => (
                    <option key={id} value={id} />
                  ))}
                </datalist>
              ) : null}
              {activePreset.docsHint ? (
                <span className="muted status-inline">{activePreset.docsHint}</span>
              ) : null}
              {activePreset.docsPath ? (
                <span className="muted status-inline">
                  <a
                    href={`https://playon.games${activePreset.docsPath}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Setup guide
                  </a>
                </span>
              ) : null}
              {fieldErrors.model ? (
                <span className="field-error">{fieldErrors.model}</span>
              ) : null}
            </label>
            <label className="field">
              <span>
                API key{" "}
                {llm.data?.llm.hasApiKey ? "(saved — leave blank to keep)" : ""}
              </span>
              <input
                type="password"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                autoComplete="off"
                placeholder={
                  activePreset.requiresApiKey
                    ? activePreset.apiKeyLabel
                    : "optional"
                }
                aria-invalid={Boolean(fieldErrors.apiKey) || undefined}
              />
              {fieldErrors.apiKey ? (
                <span className="field-error">{fieldErrors.apiKey}</span>
              ) : null}
            </label>

            <div className="btn-row">
              <button className="btn btn-primary" type="submit" disabled={save.isPending}>
                {save.isPending ? "Saving…" : "Save settings"}
              </button>
              {saved ? (
                <span className="ok">Saved. Open Map and send a chat to verify the model.</span>
              ) : null}
            </div>
            {save.isError ? <p className="error">{(save.error as Error).message}</p> : null}
          </div>
        )}
      </form>

      <McpAccessTokensSection />

      <form
        className="panel stack tight"
        onSubmit={(e) => {
          e.preventDefault();
          saveBackup.mutate();
        }}
      >
        <h3>Off-node backups</h3>
        <p className="muted status-inline">
          Absolute path to an external disk, USB stick, or NAS mount. Durable backups copy here so a
          dead host disk is not the only copy.
        </p>
        <label className="field">
          <span>Backup root</span>
          <input
            value={backupRoot}
            onChange={(e) => setBackupRoot(e.target.value)}
            placeholder="D:\\playon-backups or /mnt/nas/playon"
            required
          />
        </label>
        <div className="btn-row">
          <button className="btn btn-primary" type="submit" disabled={saveBackup.isPending}>
            {saveBackup.isPending ? "Saving…" : "Save backup target"}
          </button>
          {backupSaved ? <span className="ok">Saved</span> : null}
        </div>
        {saveBackup.isError ? <p className="error">{(saveBackup.error as Error).message}</p> : null}
      </form>

      {can(user.role, "skills.package") ? (
        <div className="panel stack tight">
          <h3>Skill library</h3>
          <p className="muted status-inline">
            Install curated game skills from playon.games one at a time. Platform core skills are already
            on this host.
          </p>
          <form
            className="btn-row"
            onSubmit={(e) => {
              e.preventDefault();
              setCatalogSearch(catalogQuery.trim());
            }}
          >
            <label className="field" style={{ flex: 1 }}>
              <span>Search</span>
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
          {catalog.isError ? (
            <p className="error">{(catalog.error as Error).message}</p>
          ) : null}
          {catalog.data?.error ? <p className="error">{catalog.data.error}</p> : null}
          {catalog.data?.skills?.length ? (
            <ul className="list compact-list">
              {catalog.data.skills.map((s) => (
                <li key={s.name}>
                  <div>
                    <strong>{s.game ?? s.name}</strong>
                    <div className="muted">
                      {s.name} · v{s.version}
                      {s.official ? " · official" : ""}
                      {s.containerSupport ? ` · ${s.containerSupport}` : ""}
                      {s.installed ? " · installed" : ""}
                    </div>
                    {s.description ? <p className="muted status-inline">{s.description}</p> : null}
                  </div>
                  <button
                    className="btn btn-primary"
                    type="button"
                    disabled={s.installed || installingSkill === s.name || installFromCatalog.isPending}
                    onClick={() => installFromCatalog.mutate(s.name)}
                  >
                    {s.installed
                      ? "Installed"
                      : installingSkill === s.name
                        ? "Installing…"
                        : "Install"}
                  </button>
                </li>
              ))}
            </ul>
          ) : catalog.isSuccess && !catalog.data?.error ? (
            <p className="muted status-inline">No matching skills in the catalog.</p>
          ) : null}
          {skillNotice ? <span className="ok">{skillNotice}</span> : null}
          {skillError ? <p className="error">{skillError}</p> : null}

          <details className="confirm-always-details">
            <summary>Advanced — offline / custom package</summary>
            <p className="muted status-inline">
              Air-gapped hosts can import a local skill package file. Normal installs use the library
              above or chat.
            </p>
            <label className="field">
              <span>Import package file</span>
              <input
                type="file"
                accept=".zip,application/zip"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (!file) return;
                  setSkillNotice(null);
                  setSkillError(null);
                  void api
                    .importSkill(file)
                    .then((result) => {
                      setSkillNotice(`Imported ${result.skill.skillName} v${result.skill.version}`);
                      e.target.value = "";
                      window.setTimeout(() => setSkillNotice(null), 4000);
                    })
                    .catch((err: Error) => setSkillError(err.message));
                }}
              />
            </label>
          </details>
        </div>
      ) : null}

      {can(user.role, "users.manage") ? (
        <form className="panel stack tight" onSubmit={onCreateUser}>
          <h3>Create account</h3>
          <p className="muted status-inline">
            Operators can start/stop servers and watch logs. Admins also get chat, LLM settings, and host
            confirms.
          </p>
          <div className="stack tight">
            <label className="field">
              <span>Username</span>
              <input
                value={newUsername}
                onChange={(e) => setNewUsername(e.target.value)}
                minLength={3}
                required
                autoComplete="off"
              />
            </label>
            <label className="field">
              <span>Password</span>
              <input
                type="password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                minLength={8}
                required
                autoComplete="new-password"
              />
            </label>
            <label className="field">
              <span>Role</span>
              <select
                value={newRole}
                onChange={(e) => setNewRole(e.target.value as "admin" | "operator")}
              >
                <option value="operator">Operator</option>
                <option value="admin">Admin</option>
              </select>
            </label>
            <div className="btn-row">
              <button className="btn btn-primary" type="submit" disabled={createUser.isPending}>
                {createUser.isPending ? "Creating…" : "Create user"}
              </button>
              {userCreated ? <span className="ok">Created {userCreated}</span> : null}
            </div>
            {createUser.isError ? <p className="error">{(createUser.error as Error).message}</p> : null}
          </div>
        </form>
      ) : null}
    </div>
  );
}

function McpAccessTokensSection() {
  const qc = useQueryClient();
  const tokens = useQuery({ queryKey: ["access-tokens"], queryFn: api.listAccessTokens });
  const [name, setName] = useState("Cursor / Claude / Codex");
  const [autoApprove, setAutoApprove] = useState(false);
  const [createdPlaintext, setCreatedPlaintext] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const mcpUrl =
    typeof window !== "undefined" ? `${window.location.origin}/mcp` : "http://<host>:8787/mcp";

  const create = useMutation({
    mutationFn: () =>
      api.createAccessToken({ name: name.trim() || "MCP token", autoApproveConfirms: autoApprove }),
    onSuccess: async (result) => {
      setCreatedPlaintext(result.token.token);
      setCopied(false);
      await qc.invalidateQueries({ queryKey: ["access-tokens"] });
    },
  });

  const revoke = useMutation({
    mutationFn: (id: string) => api.revokeAccessToken(id),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["access-tokens"] });
    },
  });

  const snippet = `{
  "mcpServers": {
    "playon": {
      "url": "${mcpUrl}",
      "headers": {
        "Authorization": "Bearer ${createdPlaintext ?? "playon_…"}"
      }
    }
  }
}`;

  return (
    <section className="panel stack tight">
      <h3>External agents (MCP)</h3>
      <p className="muted status-inline">
        Connect Claude Code, Codex, Cursor, OpenClaw, Hermes, or other MCP clients with a PlayOn
        access token. Your agent can set up servers end-to-end and manage them afterward — same tools
        as in-app agents. No cloud LLM key required on this host.{" "}
        <a href="https://playon.games/docs/mcp" target="_blank" rel="noreferrer">
          Setup guides
        </a>
      </p>
      <label className="field">
        <span>MCP URL</span>
        <input value={mcpUrl} readOnly />
      </label>
      <label className="field">
        <span>Token name</span>
        <input value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      <label className="field checkbox-row">
        <input
          type="checkbox"
          checked={autoApprove}
          onChange={(e) => setAutoApprove(e.target.checked)}
        />
        <span>Auto-approve confirm-gated tools (trusted automation; still audited)</span>
      </label>
      <div className="btn-row">
        <button
          className="btn btn-primary"
          type="button"
          disabled={create.isPending}
          onClick={() => create.mutate()}
        >
          {create.isPending ? "Creating…" : "Create access token"}
        </button>
      </div>
      {create.isError ? <p className="error">{(create.error as Error).message}</p> : null}
      {createdPlaintext ? (
        <div className="stack tight">
          <p className="ok">Copy this token now — it will not be shown again.</p>
          <label className="field">
            <span>Token</span>
            <input value={createdPlaintext} readOnly />
          </label>
          <pre className="code-block">{snippet}</pre>
          <div className="btn-row">
            <button
              className="btn"
              type="button"
              onClick={async () => {
                await navigator.clipboard.writeText(snippet);
                setCopied(true);
                window.setTimeout(() => setCopied(false), 2000);
              }}
            >
              {copied ? "Copied" : "Copy client snippet"}
            </button>
          </div>
        </div>
      ) : null}
      {tokens.isLoading ? (
        <p className="muted">Loading tokens…</p>
      ) : tokens.data?.tokens.length ? (
        <ul className="stack tight">
          {tokens.data.tokens.map((t) => (
            <li key={t.id} className="btn-row" style={{ justifyContent: "space-between" }}>
              <span>
                {t.name}
                {t.autoApproveConfirms ? " · auto-approve" : ""}
                <span className="muted"> · {new Date(t.createdAt).toLocaleString()}</span>
              </span>
              <button
                className="btn"
                type="button"
                disabled={revoke.isPending}
                onClick={() => {
                  if (window.confirm(`Revoke token “${t.name}”?`)) revoke.mutate(t.id);
                }}
              >
                Revoke
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted">No active access tokens.</p>
      )}
    </section>
  );
}
