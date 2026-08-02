import { useEffect, useMemo, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { can, type PublicUser } from "@playon/shared";
import { api, type LlmPublic } from "../api";


export function SettingsPage({ user }: { user: PublicUser }) {
  const qc = useQueryClient();
  const llm = useQuery({ queryKey: ["llm"], queryFn: api.getLlmSettings });
  const [provider, setProvider] = useState<LlmPublic["provider"]>("openai_compatible");
  const [baseUrl, setBaseUrl] = useState("");
  const [model, setModel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [saved, setSaved] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<{ model?: string; apiKey?: string }>({});

  const [newUsername, setNewUsername] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [newRole, setNewRole] = useState<"admin" | "operator">("operator");
  const [userCreated, setUserCreated] = useState<string | null>(null);
  const [backupRoot, setBackupRoot] = useState("");
  const [backupSaved, setBackupSaved] = useState(false);
  const [skillNotice, setSkillNotice] = useState<string | null>(null);
  const [skillError, setSkillError] = useState<string | null>(null);

  const backupTarget = useQuery({
    queryKey: ["backup-target"],
    queryFn: api.backupTarget,
  });

  useEffect(() => {
    if (!llm.data?.llm) return;
    setProvider(llm.data.llm.provider);
    setBaseUrl(llm.data.llm.baseUrl ?? "");
    setModel(llm.data.llm.model ?? "");
  }, [llm.data]);

  const dirty = useMemo(() => {
    const loaded = llm.data?.llm;
    if (!loaded) return false;
    return (
      provider !== loaded.provider ||
      baseUrl !== (loaded.baseUrl ?? "") ||
      model !== (loaded.model ?? "") ||
      apiKey !== ""
    );
  }, [llm.data, provider, baseUrl, model, apiKey]);

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
        provider,
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
    const errors: { model?: string; apiKey?: string } = {};
    if (!model.trim()) errors.model = "Model is required";
    if (
      provider === "openai_compatible" &&
      !llm.data?.llm.hasApiKey &&
      !apiKey.trim()
    ) {
      errors.apiKey = "API key required for Venice / OpenAI-compatible";
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
        <p className="lede">LLM provider, backups, and host accounts.</p>
      </header>

      <form className="panel stack tight" onSubmit={onSubmit}>
        <h3>LLM</h3>
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
                value={provider}
                onChange={(e) => setProvider(e.target.value as LlmPublic["provider"])}
              >
                <option value="openai_compatible">Venice / OpenAI-compatible</option>
                <option value="ollama">Ollama (offline)</option>
              </select>
            </label>

            <label className="field">
              <span>Base URL</span>
              <input
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
                placeholder={
                  provider === "ollama" ? "http://127.0.0.1:11434/v1" : "https://api.venice.ai/api/v1"
                }
              />
            </label>
            <label className="field">
              <span>Model</span>
              <input
                value={model}
                onChange={(e) => setModel(e.target.value)}
                placeholder={provider === "ollama" ? "llama3.2" : "llama-3.3-70b"}
                required
                aria-invalid={Boolean(fieldErrors.model) || undefined}
              />
              {fieldErrors.model ? (
                <span className="field-error">{fieldErrors.model}</span>
              ) : null}
            </label>
            <label className="field">
              <span>API key {llm.data?.llm.hasApiKey ? "(saved — leave blank to keep)" : ""}</span>
              <input
                type="password"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                autoComplete="off"
                placeholder={provider === "ollama" ? "optional" : "Venice API key"}
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
          <h3>Skill packages</h3>
          <p className="muted status-inline">
            Import a <code>.skill.zip</code> (directory with <code>metadata.yaml</code>) into the host
            global skills library.
          </p>
          <label className="field">
            <span>Import zip</span>
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
          {skillNotice ? <span className="ok">{skillNotice}</span> : null}
          {skillError ? <p className="error">{skillError}</p> : null}
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
