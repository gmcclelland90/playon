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

  const [addKind, setAddKind] = useState<"lan" | "cloud">("lan");
  const [addHost, setAddHost] = useState("");
  const [addUser, setAddUser] = useState("root");
  const [addPassword, setAddPassword] = useState("");
  const [addNodeName, setAddNodeName] = useState("");
  const [oneLiner, setOneLiner] = useState<string | null>(null);
  const [nodeNotice, setNodeNotice] = useState<string | null>(null);
  const [nodeError, setNodeError] = useState<string | null>(null);
  const [dockerInstallNodeId, setDockerInstallNodeId] = useState<string | null>(null);
  const [dockerSshHost, setDockerSshHost] = useState("");
  const [dockerSshUser, setDockerSshUser] = useState("root");
  const [dockerSshPassword, setDockerSshPassword] = useState("");
  const [dockerOneLiner, setDockerOneLiner] = useState<string | null>(null);
  const [dockerWaitingId, setDockerWaitingId] = useState<string | null>(null);
  const [ollamaCustomModel, setOllamaCustomModel] = useState(false);
  const [pullTarget, setPullTarget] = useState("");
  const [ollamaNotice, setOllamaNotice] = useState<string | null>(null);
  const [ollamaError, setOllamaError] = useState<string | null>(null);
  const [copiedManual, setCopiedManual] = useState(false);
  const [lastOllamaJobAt, setLastOllamaJobAt] = useState<string | null>(null);

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

  const updates = useQuery({
    queryKey: ["updates"],
    queryFn: () => api.updatesStatus(false),
    enabled: can(user.role, "settings.llm"),
    refetchInterval: 10_000,
  });

  const checkUpdates = useMutation({
    mutationFn: () => api.updatesStatus(true),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["updates"] });
    },
  });

  const applyHomeUpdate = useMutation({
    mutationFn: api.applyHomeUpdate,
    onError: (err) => setNodeError((err as Error).message),
  });

  const updateNodeMut = useMutation({
    mutationFn: (nodeId: string) => api.updateNode(nodeId),
    onSuccess: async (_data, nodeId) => {
      setNodeNotice(`Update queued for ${nodeId}. Waiting for the node to restart…`);
      await qc.invalidateQueries({ queryKey: ["updates"] });
      await qc.invalidateQueries({ queryKey: ["nodes"] });
    },
    onError: (err) => setNodeError((err as Error).message),
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

  const installDockerSshMut = useMutation({
    mutationFn: (nodeId: string) =>
      api.installDockerViaSsh(nodeId, {
        host: dockerSshHost.trim(),
        username: dockerSshUser.trim(),
        password: dockerSshPassword || undefined,
      }),
    onSuccess: async (res) => {
      setDockerSshPassword("");
      setDockerWaitingId(res.nodeId);
      setNodeNotice("Docker install started — waiting for the node to report Docker…");
      await qc.invalidateQueries({ queryKey: ["nodes"] });
    },
    onError: (err: Error) => setNodeError(err.message),
  });

  const installDockerTokenMut = useMutation({
    mutationFn: (nodeId: string) => api.createInstallDockerToken(nodeId),
    onSuccess: (res) => {
      setDockerOneLiner(res.oneLiner);
      setDockerWaitingId(res.nodeId);
      setNodeNotice(
        `One-liner ready (expires ${new Date(res.expiresAt).toLocaleString()}). Run it on the node, then wait for Docker.`,
      );
    },
    onError: (err: Error) => setNodeError(err.message),
  });

  useEffect(() => {
    if (!dockerWaitingId || !nodesList.data?.nodes) return;
    const n = nodesList.data.nodes.find((x) => x.id === dockerWaitingId);
    if (n?.docker) {
      setNodeNotice(`Docker is available on ${n.name}.`);
      setDockerWaitingId(null);
      setDockerInstallNodeId(null);
      setDockerOneLiner(null);
      window.setTimeout(() => setNodeNotice(null), 4000);
    }
  }, [dockerWaitingId, nodesList.data?.nodes]);

  const ollamaStatus = useQuery({
    queryKey: ["ollama-status", baseUrl],
    queryFn: () => api.getOllamaStatus(baseUrl || undefined),
    enabled: can(user.role, "settings.llm") && preset === "ollama",
    refetchInterval: (q) => {
      const phase = q.state.data?.ollama.job.phase;
      if (phase === "installing" || phase === "pulling") return 1500;
      return 8_000;
    },
  });

  const ollamaJobBusy =
    ollamaStatus.data?.ollama.job.phase === "installing" ||
    ollamaStatus.data?.ollama.job.phase === "pulling";

  const installOllamaMut = useMutation({
    mutationFn: () => api.installOllama(baseUrl || undefined),
    onSuccess: async () => {
      setOllamaError(null);
      setOllamaNotice("Installing Ollama…");
      await qc.invalidateQueries({ queryKey: ["ollama-status"] });
    },
    onError: (err: Error) => {
      setOllamaNotice(null);
      setOllamaError(err.message);
    },
  });

  const pullOllamaMut = useMutation({
    mutationFn: (name: string) =>
      api.pullOllamaModel({ model: name, baseUrl: baseUrl || undefined }),
    onSuccess: async (_res, name) => {
      setOllamaError(null);
      setOllamaNotice(`Pulling ${name}…`);
      setModel(name);
      setOllamaCustomModel(false);
      await qc.invalidateQueries({ queryKey: ["ollama-status"] });
    },
    onError: (err: Error) => {
      setOllamaNotice(null);
      setOllamaError(err.message);
    },
  });

  useEffect(() => {
    const job = ollamaStatus.data?.ollama.job;
    if (!job) return;
    if (job.updatedAt === lastOllamaJobAt) return;
    if (job.phase !== "ready" && job.phase !== "error") return;
    setLastOllamaJobAt(job.updatedAt);
    if (job.phase === "ready" && job.message) {
      setOllamaNotice(job.message);
      setOllamaError(null);
      window.setTimeout(() => setOllamaNotice(null), 4000);
    } else if (job.phase === "error" && job.message) {
      setOllamaError(job.message);
      setOllamaNotice(null);
    }
  }, [ollamaStatus.data?.ollama.job, lastOllamaJobAt]);

  useEffect(() => {
    if (preset !== "ollama") {
      setOllamaCustomModel(false);
      setPullTarget("");
      return;
    }
    const names = ollamaStatus.data?.ollama.models.map((m) => m.name) ?? [];
    if (!names.length) return;
    if (!model.trim()) {
      if (!ollamaCustomModel) setModel(names[0]!);
      return;
    }
    const installed =
      names.includes(model) || names.some((n) => n === model || n.startsWith(`${model}:`));
    if (!installed) {
      setOllamaCustomModel(true);
      return;
    }
    if (!ollamaCustomModel && !names.includes(model)) {
      const tagged = names.find((n) => n.startsWith(`${model}:`));
      setModel(tagged ?? names[0]!);
    }
  }, [preset, ollamaStatus.data?.ollama.models, model, ollamaCustomModel]);

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
    setOllamaCustomModel(false);
    setOllamaError(null);
    setOllamaNotice(null);
  }

  async function copyManualCommand(cmd: string) {
    try {
      await navigator.clipboard.writeText(cmd);
      setCopiedManual(true);
      window.setTimeout(() => setCopiedManual(false), 2000);
    } catch {
      setOllamaError("Could not copy command");
    }
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
        <h3>About / Updates</h3>
        <p className="muted status-inline">
          PlayOn Home {updates.data?.currentVersion ?? "…"}
          {updates.data?.latestVersion
            ? updates.data.homeUpdateAvailable
              ? ` · ${updates.data.latestVersion} available`
              : " · up to date"
            : updates.data?.manifestError
              ? ` · ${updates.data.manifestError}`
              : ""}
        </p>
        {updates.data?.notesUrl ? (
          <p className="muted status-inline">
            <a href={updates.data.notesUrl} target="_blank" rel="noreferrer">
              Release notes
            </a>
            {updates.data.checkedAt ? ` · last checked ${new Date(updates.data.checkedAt).toLocaleString()}` : ""}
          </p>
        ) : null}
        <div className="btn-row">
          <button
            type="button"
            className="btn"
            disabled={checkUpdates.isPending}
            onClick={() => checkUpdates.mutate()}
          >
            {checkUpdates.isPending ? "Checking…" : "Check now"}
          </button>
          {user.role === "owner" && updates.data?.homeUpdateAvailable ? (
            <button
              type="button"
              className="btn btn-primary"
              disabled={applyHomeUpdate.isPending || updates.data.applying}
              onClick={() => {
                if (!window.confirm("Download and install the update? PlayOn will restart briefly.")) {
                  return;
                }
                setNodeError(null);
                applyHomeUpdate.mutate();
              }}
            >
              {applyHomeUpdate.isPending || updates.data.applying ? "Updating…" : "Update & restart"}
            </button>
          ) : null}
        </div>
        {updates.data?.applyMessage ? (
          <p className="muted status-inline">{updates.data.applyMessage}</p>
        ) : null}
        {updates.data?.nodes?.some((n) => n.updateAvailable) ? (
          <p className="muted status-inline">
            Some remote nodes need an update — use Update on each node below (after Home is current).
          </p>
        ) : null}
      </section>

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
            {nodesList.data.nodes.map((n) => {
              const needsDocker = !n.docker;
              const isWindows = n.os === "windows";
              const panelOpen = dockerInstallNodeId === n.id;
              const nodeUpdate = updates.data?.nodes?.find((u) => u.nodeId === n.id);
              const needsAgentUpdate = Boolean(nodeUpdate?.updateAvailable);
              const homeBlocksNodeUpdate =
                Boolean(updates.data && !updates.data.homeCurrentEnoughForNodes) && n.id !== "local";
              return (
              <li key={n.id}>
                <div className="btn-row" style={{ justifyContent: "space-between" }}>
                  <div>
                    <strong>{n.name}</strong>{" "}
                    <span className="muted">{n.badge ?? n.kind}</span>
                    <div className="muted">
                      {n.status}
                      {n.docker ? " · Docker" : " · no Docker"}
                      {n.agentVersion ? ` · v${n.agentVersion}` : ""}
                      {needsAgentUpdate ? " · update available" : ""}
                      {n.tunnelStatus && n.tunnelStatus !== "none"
                        ? ` · tunnel ${n.tunnelStatus}`
                        : ""}
                      {dockerWaitingId === n.id ? " · waiting for Docker…" : ""}
                    </div>
                  </div>
                  <div className="btn-row">
                    {needsDocker && !isWindows ? (
                      <button
                        className="btn btn-primary"
                        type="button"
                        onClick={() => {
                          setNodeError(null);
                          setDockerOneLiner(null);
                          setDockerInstallNodeId(panelOpen ? null : n.id);
                          setDockerSshHost(n.id === "local" ? "127.0.0.1" : "");
                          setDockerSshUser("root");
                        }}
                      >
                        {panelOpen ? "Cancel" : "Install Docker"}
                      </button>
                    ) : null}
                    {n.id !== "local" && user.role === "owner" && needsAgentUpdate ? (
                      <button
                        className="btn btn-primary"
                        type="button"
                        title={
                          homeBlocksNodeUpdate
                            ? "Update PlayOn Home first"
                            : `Update to ${updates.data?.latestVersion ?? "latest"}`
                        }
                        disabled={
                          homeBlocksNodeUpdate ||
                          updateNodeMut.isPending ||
                          n.status === "offline"
                        }
                        onClick={() => {
                          setNodeError(null);
                          updateNodeMut.mutate(n.id);
                        }}
                      >
                        {updateNodeMut.isPending ? "Updating…" : "Update"}
                      </button>
                    ) : null}
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
                </div>
                {homeBlocksNodeUpdate && needsAgentUpdate ? (
                  <p className="muted status-inline">
                    Update PlayOn Home first, then update this node.
                  </p>
                ) : null}
                {needsDocker && isWindows ? (
                  <p className="muted status-inline">
                    Install{" "}
                    <a
                      href="https://docs.docker.com/desktop/setup/install/windows-install/"
                      target="_blank"
                      rel="noreferrer"
                    >
                      Docker Desktop
                    </a>
                    , then wait for the next heartbeat (or refresh this page).
                  </p>
                ) : null}
                {panelOpen && needsDocker && !isWindows ? (
                  <div className="stack tight" style={{ marginTop: "0.5rem" }}>
                    <p className="muted status-inline">
                      Install Docker Engine on this Linux node, then wait for it to report Docker.
                      Guide:{" "}
                      <a href="https://playon.games/docs/docker" target="_blank" rel="noreferrer">
                        playon.games/docs/docker
                      </a>
                    </p>
                    <label className="field">
                      <span>SSH host</span>
                      <input
                        value={dockerSshHost}
                        onChange={(e) => setDockerSshHost(e.target.value)}
                        placeholder={n.id === "local" ? "127.0.0.1" : "192.168.1.50"}
                      />
                    </label>
                    <label className="field">
                      <span>SSH username</span>
                      <input
                        value={dockerSshUser}
                        onChange={(e) => setDockerSshUser(e.target.value)}
                      />
                    </label>
                    <label className="field">
                      <span>SSH password</span>
                      <input
                        type="password"
                        value={dockerSshPassword}
                        onChange={(e) => setDockerSshPassword(e.target.value)}
                        autoComplete="off"
                      />
                    </label>
                    <div className="btn-row">
                      <button
                        className="btn btn-primary"
                        type="button"
                        disabled={
                          installDockerSshMut.isPending || !dockerSshHost.trim()
                        }
                        onClick={() => {
                          setNodeError(null);
                          installDockerSshMut.mutate(n.id);
                        }}
                      >
                        {installDockerSshMut.isPending ? "Installing…" : "Install via SSH"}
                      </button>
                      <button
                        className="btn"
                        type="button"
                        disabled={installDockerTokenMut.isPending}
                        onClick={() => {
                          setNodeError(null);
                          installDockerTokenMut.mutate(n.id);
                        }}
                      >
                        {installDockerTokenMut.isPending ? "…" : "Copy one-liner instead"}
                      </button>
                    </div>
                    {dockerOneLiner && dockerInstallNodeId === n.id ? (
                      <label className="field">
                        <span>Run on the target machine</span>
                        <textarea readOnly rows={3} value={dockerOneLiner} />
                      </label>
                    ) : null}
                  </div>
                ) : null}
              </li>
              );
            })}
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

            {preset === "ollama" ? (
              <div className="stack tight">
                <div className="field">
                  <span>Ollama status</span>
                  <p className="muted status-inline">
                    {ollamaStatus.isLoading
                      ? "Checking…"
                      : ollamaJobBusy
                        ? ollamaStatus.data?.ollama.job.message ||
                          (ollamaStatus.data?.ollama.job.phase === "installing"
                            ? "Installing…"
                            : "Pulling…")
                        : ollamaStatus.data?.ollama.reachable
                          ? `Connected${
                              ollamaStatus.data.ollama.version
                                ? ` (v${ollamaStatus.data.ollama.version})`
                                : ""
                            } — ${ollamaStatus.data.ollama.models.length} model${
                              ollamaStatus.data.ollama.models.length === 1 ? "" : "s"
                            }`
                          : "Not reachable"}
                  </p>
                  {ollamaStatus.data &&
                  !ollamaStatus.data.ollama.reachable &&
                  ollamaStatus.data.ollama.canInstallLocal ? (
                    <div className="btn-row">
                      <button
                        type="button"
                        className="btn btn-primary"
                        disabled={ollamaJobBusy || installOllamaMut.isPending}
                        onClick={() => installOllamaMut.mutate()}
                      >
                        {ollamaJobBusy &&
                        ollamaStatus.data.ollama.job.phase === "installing"
                          ? "Installing…"
                          : "Install Ollama"}
                      </button>
                      <span className="muted status-inline">
                        Runs via Docker on this Home host (container playon-ollama).
                      </span>
                    </div>
                  ) : null}
                  {ollamaStatus.data &&
                  !ollamaStatus.data.ollama.reachable &&
                  ollamaStatus.data.ollama.isLoopback &&
                  !ollamaStatus.data.ollama.canInstallLocal &&
                  ollamaStatus.data.ollama.manualCommand ? (
                    <div className="stack tight">
                      <p className="muted status-inline">
                        Docker is not available on this host. Install Ollama manually, then
                        refresh:
                      </p>
                      <code className="status-inline">{ollamaStatus.data.ollama.manualCommand}</code>
                      <div className="btn-row">
                        <button
                          type="button"
                          className="btn"
                          onClick={() =>
                            void copyManualCommand(ollamaStatus.data!.ollama.manualCommand!)
                          }
                        >
                          {copiedManual ? "Copied" : "Copy command"}
                        </button>
                        <button
                          type="button"
                          className="btn"
                          onClick={() => void ollamaStatus.refetch()}
                        >
                          Recheck
                        </button>
                      </div>
                    </div>
                  ) : null}
                  {ollamaStatus.data &&
                  !ollamaStatus.data.ollama.reachable &&
                  !ollamaStatus.data.ollama.isLoopback ? (
                    <p className="muted status-inline">
                      Remote Ollama URL — one-click install only works for localhost. Start
                      Ollama on that host, or switch Base URL to 127.0.0.1.
                    </p>
                  ) : null}
                  {ollamaNotice ? <p className="ok">{ollamaNotice}</p> : null}
                  {ollamaError ? <p className="error">{ollamaError}</p> : null}
                </div>

                <label className="field">
                  <span>Model</span>
                  {ollamaCustomModel ||
                  !(ollamaStatus.data?.ollama.models.length ?? 0) ? (
                    <input
                      value={model}
                      onChange={(e) => setModel(e.target.value)}
                      list="llm-model-suggestions"
                      placeholder={activePreset.defaultModel || "model-id"}
                      required
                      aria-invalid={Boolean(fieldErrors.model) || undefined}
                    />
                  ) : (
                    <select
                      value={
                        ollamaStatus.data!.ollama.models.some((m) => m.name === model)
                          ? model
                          : ollamaStatus.data!.ollama.models[0]?.name ?? ""
                      }
                      onChange={(e) => {
                        if (e.target.value === "__custom__") {
                          setOllamaCustomModel(true);
                          return;
                        }
                        setModel(e.target.value);
                      }}
                      required
                      aria-invalid={Boolean(fieldErrors.model) || undefined}
                    >
                      {ollamaStatus.data!.ollama.models.map((m) => (
                        <option key={m.name} value={m.name}>
                          {m.name}
                        </option>
                      ))}
                      <option value="__custom__">Custom model name…</option>
                    </select>
                  )}
                  {ollamaStatus.data?.ollama.models.length ? (
                    <span className="muted status-inline">
                      <button
                        type="button"
                        className="linkish"
                        onClick={() => setOllamaCustomModel((v) => !v)}
                      >
                        {ollamaCustomModel ? "Choose installed model" : "Enter custom name"}
                      </button>
                    </span>
                  ) : (
                    <span className="muted status-inline">
                      No models installed yet — pull one below or type a name.
                    </span>
                  )}
                  {fieldErrors.model ? (
                    <span className="field-error">{fieldErrors.model}</span>
                  ) : null}
                </label>

                <div className="field">
                  <span>Pull a model</span>
                  <div className="btn-row">
                    <select
                      value={pullTarget}
                      onChange={(e) => setPullTarget(e.target.value)}
                      disabled={!ollamaStatus.data?.ollama.reachable || ollamaJobBusy}
                    >
                      <option value="">Suggested…</option>
                      {activePreset.suggestedModels.map((id) => (
                        <option key={id} value={id}>
                          {id}
                        </option>
                      ))}
                    </select>
                    <button
                      type="button"
                      className="btn"
                      disabled={
                        !pullTarget ||
                        !ollamaStatus.data?.ollama.reachable ||
                        ollamaJobBusy ||
                        pullOllamaMut.isPending
                      }
                      onClick={() => pullOllamaMut.mutate(pullTarget)}
                    >
                      {ollamaJobBusy &&
                      ollamaStatus.data?.ollama.job.phase === "pulling"
                        ? "Pulling…"
                        : "Pull"}
                    </button>
                  </div>
                </div>

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
                <datalist id="llm-model-suggestions">
                  {activePreset.suggestedModels.map((id) => (
                    <option key={id} value={id} />
                  ))}
                  {(ollamaStatus.data?.ollama.models ?? []).map((m) => (
                    <option key={`installed-${m.name}`} value={m.name} />
                  ))}
                </datalist>
              </div>
            ) : (
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
            )}
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
