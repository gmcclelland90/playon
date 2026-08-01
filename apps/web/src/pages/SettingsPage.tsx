import { useEffect, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { can, type PublicUser } from "@playon/shared";
import { api, type LlmPublic } from "../api";


export function SettingsPage({ user }: { user: PublicUser }) {
  const qc = useQueryClient();
  const llm = useQuery({ queryKey: ["llm"], queryFn: api.getLlmSettings });
  const [provider, setProvider] = useState<LlmPublic["provider"]>("mock");
  const [baseUrl, setBaseUrl] = useState("");
  const [model, setModel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [saved, setSaved] = useState(false);

  const [newUsername, setNewUsername] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [newRole, setNewRole] = useState<"admin" | "operator">("operator");
  const [userCreated, setUserCreated] = useState<string | null>(null);
  const [backupRoot, setBackupRoot] = useState("");
  const [backupSaved, setBackupSaved] = useState(false);

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
      setSaved(true);
      await qc.invalidateQueries({ queryKey: ["llm"] });
      window.setTimeout(() => setSaved(false), 2000);
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
    save.mutate();
  }

  function onCreateUser(e: FormEvent) {
    e.preventDefault();
    createUser.mutate();
  }

  return (
    <div className="stack">
      <header className="page-header">
        <h2>Settings</h2>
        <p className="lede">LLM provider and host accounts.</p>
      </header>

      <form className="panel" onSubmit={onSubmit}>
        <h3>LLM</h3>
        <div className="stack tight">
          <label className="field">
            <span>Provider</span>
            <select value={provider} onChange={(e) => setProvider(e.target.value as LlmPublic["provider"])}>
              <option value="mock">Mock (offline)</option>
              <option value="openai_compatible">OpenAI-compatible</option>
              <option value="ollama">Ollama</option>
            </select>
          </label>

          {provider !== "mock" ? (
            <>
              <label className="field">
                <span>Base URL</span>
                <input
                  value={baseUrl}
                  onChange={(e) => setBaseUrl(e.target.value)}
                  placeholder={provider === "ollama" ? "http://127.0.0.1:11434" : "https://…"}
                />
              </label>
              <label className="field">
                <span>Model</span>
                <input value={model} onChange={(e) => setModel(e.target.value)} placeholder="model id" />
              </label>
              <label className="field">
                <span>API key {llm.data?.llm.hasApiKey ? "(saved — leave blank to keep)" : ""}</span>
                <input
                  type="password"
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  autoComplete="off"
                  placeholder={provider === "ollama" ? "optional" : "sk-…"}
                />
              </label>
            </>
          ) : null}

          <div className="btn-row">
            <button className="btn btn-primary" type="submit" disabled={save.isPending}>
              {save.isPending ? "Saving…" : "Save settings"}
            </button>
            {saved ? <span className="ok">Saved</span> : null}
          </div>
          {save.isError ? <p className="error">{(save.error as Error).message}</p> : null}
        </div>
      </form>

      <form
        className="panel stack tight"
        onSubmit={(e) => {
          e.preventDefault();
          saveBackup.mutate();
        }}
      >
        <h3>Off-node backups</h3>
        <p className="muted">
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
          <p className="muted">
            Import a <code>.skill.zip</code> (directory with <code>metadata.yaml</code>) into the host
            global skills library. Export from the Servers page.
          </p>
          <label className="field">
            <span>Import zip</span>
            <input
              type="file"
              accept=".zip,application/zip"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (!file) return;
                void api
                  .importSkill(file)
                  .then((result) => {
                    window.alert(`Imported ${result.skill.skillName} v${result.skill.version}`);
                    e.target.value = "";
                  })
                  .catch((err: Error) => window.alert(err.message));
              }}
            />
          </label>
        </div>
      ) : null}

      {can(user.role, "users.manage") ? (
        <form className="panel" onSubmit={onCreateUser}>
          <h3>Create account</h3>
          <p className="muted">
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
