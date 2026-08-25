import { useState, type FormEvent } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { TotpQr } from "../components/TotpQr";

type View = "form" | "mfa-offer" | "mfa-qr" | "mfa-backups";

export function SetupPage() {
  const qc = useQueryClient();
  const [view, setView] = useState<View>("form");
  const [username, setUsername] = useState("host");
  const [displayName, setDisplayName] = useState("LAN Host");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [totpCode, setTotpCode] = useState("");
  const [disableHostFile, setDisableHostFile] = useState(false);
  const [enroll, setEnroll] = useState<{ otpauthUrl: string; secret: string } | null>(null);
  const [backupCodes, setBackupCodes] = useState<string[]>([]);
  const [copiedBackups, setCopiedBackups] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function finishSetup() {
    await qc.invalidateQueries({ queryKey: ["setup"] });
    await qc.invalidateQueries({ queryKey: ["me"] });
  }

  const mutation = useMutation({
    mutationFn: () => api.bootstrapOwner({ username, password, displayName }),
    onSuccess: () => {
      setView("mfa-offer");
      setError(null);
    },
    onError: (err: Error) => setError(err.message),
  });

  const startEnroll = useMutation({
    mutationFn: api.startMfaEnroll,
    onSuccess: (result) => {
      setEnroll(result);
      setView("mfa-qr");
      setError(null);
    },
    onError: (err: Error) => setError(err.message),
  });

  const confirmEnroll = useMutation({
    mutationFn: () =>
      api.confirmMfaEnroll({ code: totpCode, disableHostFileReset: disableHostFile }),
    onSuccess: (result) => {
      setBackupCodes(result.backupCodes);
      setView("mfa-backups");
      setError(null);
    },
    onError: (err: Error) => setError(err.message?.trim() === "invalid_totp" ? "That code didn't match. Try the next one from the app." : err.message),
  });

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (password !== confirmPassword) {
      setError("Passwords don't match.");
      return;
    }
    mutation.mutate();
  }

  async function skipMfa() {
    setError(null);
    try {
      await api.cancelMfaEnroll();
    } catch {
      // Session might already be enough; continue to the Map.
    }
    await finishSetup();
  }

  const pending = mutation.isPending || startEnroll.isPending || confirmEnroll.isPending;

  return (
    <div className="auth-screen">
      {view === "form" ? (
        <form className="auth-panel" onSubmit={onSubmit}>
          <header className="auth-brand">
            <h1 className="brand-mark">
              Play<span>On</span>
            </h1>
            <p className="lede">Create the Owner account for this LAN control plane.</p>
          </header>
          <label className="field">
            <span>Username</span>
            <input
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              required
              minLength={3}
              autoComplete="username"
              autoFocus
              disabled={pending}
            />
          </label>
          <label className="field">
            <span>Display name</span>
            <input
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              required
              autoComplete="nickname"
              disabled={pending}
            />
          </label>
          <label className="field">
            <span>Password</span>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              minLength={8}
              autoComplete="new-password"
              disabled={pending}
            />
            <span className="field-hint">At least 8 characters. Stored only on this host.</span>
          </label>
          <label className="field">
            <span>Confirm password</span>
            <input
              type="password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              required
              minLength={8}
              autoComplete="new-password"
              disabled={pending}
              aria-invalid={error === "Passwords don't match." || undefined}
            />
          </label>
          {error ? (
            <p className="error" role="alert">
              {error}
            </p>
          ) : null}
          <button className="btn btn-primary" type="submit" disabled={pending}>
            {mutation.isPending ? "Creating…" : "Create Owner"}
          </button>
          <p className="muted auth-foot">You&apos;ll land on the Map next to describe a server.</p>
        </form>
      ) : null}

      {view === "mfa-offer" ? (
        <div className="auth-panel">
          <header className="auth-brand">
            <h1 className="brand-mark">
              Play<span>On</span>
            </h1>
            <p className="lede">Protect this host with an authenticator?</p>
          </header>
          <p className="muted status-inline">
            Scan a QR with Aegis, Google Authenticator, Authy, or any TOTP app. You can skip and keep
            the host-file password reset instead.
          </p>
          {error ? (
            <p className="error" role="alert">
              {error}
            </p>
          ) : null}
          <button
            className="btn btn-primary"
            type="button"
            disabled={pending}
            onClick={() => startEnroll.mutate()}
          >
            {startEnroll.isPending ? "Starting…" : "Set up authenticator"}
          </button>
          <button className="auth-text-action" type="button" disabled={pending} onClick={() => void skipMfa()}>
            Skip for now
          </button>
        </div>
      ) : null}

      {view === "mfa-qr" && enroll ? (
        <form
          className="auth-panel"
          onSubmit={(e) => {
            e.preventDefault();
            confirmEnroll.mutate();
          }}
        >
          <header className="auth-brand">
            <h1 className="brand-mark">
              Play<span>On</span>
            </h1>
            <p className="lede">Scan this QR, then enter the 6-digit code.</p>
          </header>
          <TotpQr value={enroll.otpauthUrl} />
          <p className="field-hint">
            Can&apos;t scan? Enter this secret: <code className="totp-secret">{enroll.secret}</code>
          </p>
          <label className="field">
            <span>Authenticator code</span>
            <input
              value={totpCode}
              onChange={(e) => setTotpCode(e.target.value)}
              required
              inputMode="numeric"
              autoComplete="one-time-code"
              autoFocus
              spellCheck={false}
              disabled={pending}
            />
          </label>
          <label className="field checkbox-row">
            <input
              type="checkbox"
              checked={disableHostFile}
              onChange={(e) => setDisableHostFile(e.target.checked)}
              disabled={pending}
            />
            <span>Turn off host-file recovery. You will need this app or a backup code to reset the password.</span>
          </label>
          {error ? (
            <p className="error" role="alert">
              {error}
            </p>
          ) : null}
          <button className="btn btn-primary" type="submit" disabled={pending}>
            {confirmEnroll.isPending ? "Checking…" : "Confirm and continue"}
          </button>
          <button className="auth-text-action" type="button" disabled={pending} onClick={() => void skipMfa()}>
            Skip for now
          </button>
        </form>
      ) : null}

      {view === "mfa-backups" ? (
        <div className="auth-panel">
          <header className="auth-brand">
            <h1 className="brand-mark">
              Play<span>On</span>
            </h1>
            <p className="lede">Save these backup codes. They are shown once.</p>
          </header>
          <ul className="backup-codes">
            {backupCodes.map((item) => (
              <li key={item}>
                <code>{item}</code>
              </li>
            ))}
          </ul>
          <div className="btn-row">
            <button
              className="btn btn-ghost"
              type="button"
              onClick={() => {
                void navigator.clipboard.writeText(backupCodes.join("\n"));
                setCopiedBackups(true);
              }}
            >
              {copiedBackups ? "Copied" : "Copy codes"}
            </button>
            <button className="btn btn-primary" type="button" onClick={() => void finishSetup()}>
              Done — open the Map
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
