import { useEffect, useMemo, useState, type FormEvent } from "react";
import { Link, useLocation } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  can,
  getLlmPreset,
  LLM_PRESET_LIST,
  type LlmPresetId,
  type PublicUser,
} from "@playon/shared";
import { api } from "../api";
import { WatchersPanel } from "../components/WatchersPanel";
import {
  isPendingNodeSetup,
  nodePresenceHint,
  nodePresenceLabel,
  runtimeErrorHint,
} from "../status";
import { McpAccessTokensSection } from "./settings/McpAccessTokensSection";

type SettingsSectionId =
  | "about"
  | "panel"
  | "nodes"
  | "llm"
  | "mcp"
  | "backups"
  | "accounts"
  | "watchers";

const SETTINGS_SECTIONS: Array<{ id: SettingsSectionId; label: string }> = [
  { id: "about", label: "About / Updates" },
  { id: "panel", label: "Panel URL" },
  { id: "nodes", label: "Nodes" },
  { id: "llm", label: "In-app agents" },
  { id: "mcp", label: "External agents" },
  { id: "backups", label: "Off-node backups" },
  { id: "accounts", label: "Accounts" },
  { id: "watchers", label: "Watchers" },
];

function nodeActionError(err: Error): string {
  return runtimeErrorHint(err.message) ?? err.message;
}

function sectionFromHash(hash: string, canAccounts: boolean, canWatchers: boolean): SettingsSectionId {
  const raw = hash.replace(/^#/, "") as SettingsSectionId;
  const allowed = SETTINGS_SECTIONS.filter((s) => {
    if (s.id === "accounts") return canAccounts;
    if (s.id === "watchers") return canWatchers;
    return true;
  }).map((s) => s.id);
  if (allowed.includes(raw)) return raw;
  return "about";
}

export function SettingsPage({ user }: { user: PublicUser }) {
  const qc = useQueryClient();
  const location = useLocation();
  const canAccounts = can(user.role, "users.manage");
  const canWatchers = can(user.role, "watchers.read");
  const [activeSection, setActiveSection] = useState<SettingsSectionId>(() =>
    typeof window === "undefined"
      ? "about"
      : sectionFromHash(window.location.hash, canAccounts, canWatchers),
  );
  useEffect(() => {
    setActiveSection(sectionFromHash(location.hash, canAccounts, canWatchers));
  }, [location.hash, canAccounts, canWatchers]);

  function goToSection(id: SettingsSectionId) {
    setActiveSection(id);
    const next = `#${id}`;
    if (window.location.hash !== next) {
      window.history.replaceState(null, "", `${location.pathname}${next}`);
    }
  }

  const visibleSections = SETTINGS_SECTIONS.filter((s) => {
    if (s.id === "accounts") return canAccounts;
    if (s.id === "watchers") return canWatchers;
    return true;
  });

  // One section at a time on every viewport — sticky nav jumps, no desktop wall of forms.
  const showSection = (id: SettingsSectionId) => activeSection === id;

  const panelUrls = useQuery({ queryKey: ["panel-urls"], queryFn: api.getPanelUrls });
  const [panelLink, setPanelLink] = useState<{
    linkUrl: string;
    userCode: string;
  } | null>(null);
  const [panelLinkMsg, setPanelLinkMsg] = useState<string | null>(null);
  const startPanelLink = useMutation({
    mutationFn: () => api.startPanelHostnameLink(),
    onSuccess: (data) => {
      setPanelLink({ linkUrl: data.linkUrl, userCode: data.userCode });
      setPanelLinkMsg("Open the link, sign in with Discord, then click Finish here.");
    },
    onError: (err: Error) => setPanelLinkMsg(err.message),
  });
  const finishPanelLink = useMutation({
    mutationFn: async () => {
      if (!panelLink) throw new Error("Start linking first");
      for (let i = 0; i < 60; i++) {
        const res = await api.completePanelHostnameLink(panelLink.userCode);
        if (res.pending) {
          await new Promise((r) => setTimeout(r, 2000));
          continue;
        }
        return res;
      }
      throw new Error("Still waiting for Discord link — confirm on playon.games, then retry.");
    },
    onSuccess: (res) => {
      setPanelLinkMsg(
        res.hostname
          ? `Linked ${res.hostname}. ${res.restartHint ?? ""}`.trim()
          : "Linked.",
      );
      void qc.invalidateQueries({ queryKey: ["panel-urls"] });
    },
    onError: (err: Error) => setPanelLinkMsg(err.message),
  });

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

  const [nodeNotice, setNodeNotice] = useState<string | null>(null);
  const [nodeError, setNodeError] = useState<string | null>(null);
  const [aboutError, setAboutError] = useState<string | null>(null);
  /** Shown after Remove hits node_has_servers for this id. */
  const [forceRemoveNodeId, setForceRemoveNodeId] = useState<string | null>(null);
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

  const serversList = useQuery({
    queryKey: ["servers"],
    queryFn: api.servers,
    enabled: can(user.role, "watchers.read"),
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
      setAboutError(null);
      await qc.invalidateQueries({ queryKey: ["updates"] });
    },
    onError: (err) => setAboutError((err as Error).message || "Could not check for updates."),
  });

  const applyHomeUpdate = useMutation({
    mutationFn: api.applyHomeUpdate,
    onError: (err) => setAboutError((err as Error).message || "Update failed."),
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
    onError: (err: Error) => setNodeError(nodeActionError(err)),
  });

  const removeNodeMut = useMutation({
    mutationFn: ({ id, force }: { id: string; force?: boolean }) => api.removeNode(id, force),
    onSuccess: async () => {
      setForceRemoveNodeId(null);
      setNodeNotice("Node removed.");
      await qc.invalidateQueries({ queryKey: ["nodes"] });
    },
    onError: (err: Error, vars) => {
      if (err.message.startsWith("node_has_servers")) {
        setForceRemoveNodeId(vars.id);
      }
      setNodeError(nodeActionError(err));
    },
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
    onError: (err: Error) => setNodeError(nodeActionError(err)),
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
    onError: (err: Error) => setNodeError(nodeActionError(err)),
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
    <div className="settings-page">
      <header className="page-header">
        <h2>Settings</h2>
        <p className="lede">
          Same tools whether you use a cloud LLM, Ollama, or MCP — only the brain and how you
          connect change.
        </p>
      </header>

      <div className="settings-workspace">
        <nav className="settings-nav" aria-label="Settings sections">
          {visibleSections.map((s) => (
            <button
              key={s.id}
              type="button"
              className={`settings-nav-btn${activeSection === s.id ? " active" : ""}`}
              onClick={() => goToSection(s.id)}
            >
              {s.label}
            </button>
          ))}
        </nav>

        <div className="settings-section-picker">
          <label className="field">
            <span>Section</span>
            <select
              value={activeSection}
              onChange={(e) => goToSection(e.target.value as SettingsSectionId)}
            >
              {visibleSections.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label}
                </option>
              ))}
            </select>
          </label>
        </div>

        <div className="settings-content stack">
      <section
        className="panel stack tight settings-section"
        id="settings-about"
        hidden={!showSection("about")}
      >
        <h3 className="section-title">About / Updates</h3>
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
            onClick={() => {
              setAboutError(null);
              checkUpdates.mutate();
            }}
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
                setAboutError(null);
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
        {aboutError ? (
          <p className="error" role="alert">
            {aboutError}
          </p>
        ) : null}
        {updates.data?.nodes?.some((n) => n.updateAvailable) ? (
          <p className="muted status-inline">
            Some remote nodes need an update — open{" "}
            <button type="button" className="linkish" onClick={() => goToSection("nodes")}>
              Nodes
            </button>{" "}
            and use Update on each one (after Home is current).
          </p>
        ) : null}
      </section>

      <section
        className="panel stack tight settings-section"
        id="settings-panel"
        hidden={!showSection("panel")}
      >
        <h3 className="section-title">Panel URL</h3>
        <p className="muted status-inline">
          Open PlayOn at <code>http://playon.local</code>
          {panelUrls.data?.linkedHostname
            ? `, or your linked https://${panelUrls.data.linkedHostname}`
            : ", or link Discord for a https://your-handle.playon.games address"}
          . Game join addresses stay on your LAN IP.
        </p>
        <ul className="stack tight">
          {(panelUrls.data?.allUrls ?? []).map((u) => (
            <li key={u}>
              <a href={u} target="_blank" rel="noreferrer">
                {u}
              </a>
              {u === panelUrls.data?.preferredUrl ? " · preferred" : ""}
            </li>
          ))}
        </ul>
        {panelUrls.data?.lastError ? (
          <p className="muted status-inline">Hostname sync: {panelUrls.data.lastError}</p>
        ) : null}
        {user.role === "owner" ? (
          <div className="stack tight">
            <div className="btn-row">
              <button
                type="button"
                className="btn btn-primary"
                disabled={startPanelLink.isPending}
                onClick={() => {
                  setPanelLinkMsg(null);
                  startPanelLink.mutate();
                }}
              >
                {panelUrls.data?.linkedHostname ? "Re-link Discord hostname" : "Link Discord hostname"}
              </button>
              {panelLink ? (
                <button
                  type="button"
                  className="btn"
                  disabled={finishPanelLink.isPending}
                  onClick={() => finishPanelLink.mutate()}
                >
                  {finishPanelLink.isPending ? "Waiting for Discord…" : "Finish link"}
                </button>
              ) : null}
            </div>
            {panelLink ? (
              <p className="muted status-inline">
                Code <code>{panelLink.userCode}</code> —{" "}
                <a href={panelLink.linkUrl} target="_blank" rel="noreferrer">
                  open link page
                </a>
              </p>
            ) : null}
            {panelLinkMsg ? <p className="muted status-inline">{panelLinkMsg}</p> : null}
          </div>
        ) : null}
      </section>

      <section
        className="panel stack tight settings-section"
        id="settings-nodes"
        hidden={!showSection("nodes")}
      >
        <h3 className="section-title">Nodes</h3>
        <p className="muted status-inline">
          Add and monitor hosts on the{" "}
          <Link to="/">Map</Link> (host pads + Add node). Below: Local hosting toggle and
          maintenance for existing nodes.
        </p>
        {dockerInstallNodeId ? (
          <p className="muted status-inline" role="status">
            Docker install in progress — finish or Cancel below. Other node rows are hidden until
            you close the wizard.
          </p>
        ) : (
          <label className="field checkbox-row">
            <input
              type="checkbox"
              checked={nodeSettings.data?.nodes.localComputeEnabled ?? true}
              onChange={(e) => {
                const next = e.target.checked;
                const msg = next
                  ? "Enable Local hosting? This machine will be eligible to run game servers."
                  : "Turn off Local hosting? New servers won’t be placed on this machine until you turn it back on.";
                if (!window.confirm(msg)) return;
                setNodeError(null);
                saveNodeSettings.mutate(next);
              }}
              disabled={saveNodeSettings.isPending || nodeSettings.isLoading}
            />
            <span>Also host game servers on this machine (Local)</span>
          </label>
        )}
        {!dockerInstallNodeId && nodesList.data?.wireguardTools === false ? (
          <p className="muted status-inline">
            WireGuard tools not detected on Home — install wireguard-tools (Linux) or WireGuard for
            Windows before adding cloud nodes.
          </p>
        ) : null}
        {!dockerInstallNodeId && nodesList.data?.nodeTokenConfigured === false ? (
          <p className="error" role="alert">
            PLAYON_NODE_TOKEN is not set on this control plane. Add a token to the PlayOn env file
            and restart before adding LAN or cloud nodes. Home install sets this automatically.
          </p>
        ) : null}

        {nodesList.data?.nodes?.length ? (
          <ul className="list compact-list">
            {nodesList.data.nodes
              .filter((n) => !dockerInstallNodeId || n.id === dockerInstallNodeId)
              .map((n) => {
              const needsDocker = !n.docker;
              const isWindows = n.os === "windows";
              const panelOpen = dockerInstallNodeId === n.id;
              const nodeUpdate = updates.data?.nodes?.find((u) => u.nodeId === n.id);
              const needsAgentUpdate = Boolean(nodeUpdate?.updateAvailable);
              const homeBlocksNodeUpdate =
                Boolean(updates.data && !updates.data.homeCurrentEnoughForNodes) && n.id !== "local";
              const pendingSetup = isPendingNodeSetup({
                status: n.status,
                agentVersion: n.agentVersion,
              });
              const presenceHint = nodePresenceHint({
                id: n.id,
                status: n.status,
                agentVersion: n.agentVersion,
              });
              const presenceLabel = nodePresenceLabel({
                status: n.status,
                agentVersion: n.agentVersion,
              });
              const onlineish =
                n.status === "online" || presenceLabel.toLowerCase().includes("online");
              return (
              <li key={n.id}>
                <div className="btn-row" style={{ justifyContent: "space-between" }}>
                  <div>
                    <strong>{n.name}</strong>{" "}
                    <span className="muted">{n.badge ?? n.kind}</span>
                    <div className="settings-node-chips" aria-label="Node status">
                      <span className={`status-chip${onlineish ? " live" : " warn"}`}>
                        {presenceLabel}
                      </span>
                      {!pendingSetup ? (
                        <span className={`status-chip${n.docker ? " live" : " warn"}`}>
                          {n.docker ? "Docker" : "No Docker"}
                        </span>
                      ) : null}
                      {n.agentVersion && n.agentVersion !== "pending" ? (
                        <span className="status-chip">v{n.agentVersion}</span>
                      ) : null}
                      {needsAgentUpdate ? (
                        <span className="status-chip warn">Update available</span>
                      ) : null}
                      {n.tunnelStatus && n.tunnelStatus !== "none" ? (
                        <span className="status-chip">Tunnel {n.tunnelStatus}</span>
                      ) : null}
                      {dockerWaitingId === n.id ? (
                        <span className="status-chip warn">Waiting for Docker…</span>
                      ) : null}
                    </div>
                    {presenceHint ? (
                      <p className="muted status-inline">{presenceHint}</p>
                    ) : null}
                  </div>
                  <div className="btn-row">
                    {needsDocker && !isWindows && !pendingSetup ? (
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
                        className="btn btn-danger"
                        type="button"
                        disabled={removeNodeMut.isPending}
                        onClick={() => {
                          const msg = pendingSetup
                            ? `Remove incomplete node “${n.name}”? Bootstrap never finished — safe to delete.`
                            : `Remove node ${n.name}? Servers must be moved first.`;
                          if (!window.confirm(msg)) {
                            return;
                          }
                          setNodeError(null);
                          removeNodeMut.mutate({ id: n.id });
                        }}
                      >
                        Remove
                      </button>
                    ) : null}
                    {n.id !== "local" && forceRemoveNodeId === n.id ? (
                      <button
                        className="btn btn-danger"
                        type="button"
                        disabled={removeNodeMut.isPending}
                        title="Delete the node record even if servers still reference it"
                        onClick={() => {
                          if (
                            !window.confirm(
                              `Force remove node ${n.name}? Bound server records will be left without this node.`,
                            )
                          ) {
                            return;
                          }
                          setNodeError(null);
                          removeNodeMut.mutate({ id: n.id, force: true });
                        }}
                      >
                        Force remove
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

      <form
        className="panel stack tight settings-section"
        id="settings-llm"
        onSubmit={onSubmit}
        hidden={!showSection("llm")}
      >
        <h3 className="section-title">In-app agents (LLM provider)</h3>
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

      <div hidden={!showSection("mcp")}>
        <McpAccessTokensSection />
      </div>

      <form
        className="panel stack tight settings-section"
        id="settings-backups"
        onSubmit={(e) => {
          e.preventDefault();
          saveBackup.mutate();
        }}
        hidden={!showSection("backups")}
      >
        <h3 className="section-title">Off-node backups</h3>
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

      {canAccounts ? (
        <form
          className="panel stack tight settings-section"
          id="settings-accounts"
          onSubmit={onCreateUser}
          hidden={!showSection("accounts")}
        >
          <h3 className="section-title">Accounts</h3>
          <p className="muted status-inline">
            Create operator or admin logins. Operators can start/stop servers and watch logs. Admins also
            get chat, LLM settings, and host confirms.
          </p>
          <div className="settings-two-col">
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
            <aside className="field-group">
              <p className="section-label">Roles</p>
              <p className="muted status-inline">
                Operator: servers + logs. Admin: chat, LLM settings, confirms. Owner stays unique.
              </p>
            </aside>
          </div>
        </form>
      ) : null}

      {canWatchers ? (
        <section
          className="settings-section settings-span-full"
          id="settings-watchers"
          hidden={!showSection("watchers")}
        >
          <WatchersPanel
            user={user}
            serverOptions={(serversList.data?.servers ?? []).map((s) => ({
              id: s.id,
              name: s.name,
            }))}
          />
        </section>
      ) : null}
        </div>
      </div>
    </div>
  );
}
