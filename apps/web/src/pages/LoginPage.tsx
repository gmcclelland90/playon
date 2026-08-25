import { useState, type FormEvent } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { api } from "../api";

const SIGN_IN_FALLBACK = "Couldn't sign in. Check username and password.";
const RESET_FAIL_FALLBACK =
  "That code didn't work. Read the latest password-reset.txt on this host and try again.";
const TOTP_FAIL = "That authenticator code didn't work. Try the next one from the app.";

type View = "login" | "totp" | "reset-start" | "reset-pick" | "reset-code" | "reset-totp";

export function LoginPage() {
  const qc = useQueryClient();
  const [view, setView] = useState<View>("login");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [totpCode, setTotpCode] = useState("");
  const [mfaToken, setMfaToken] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [resetHint, setResetHint] = useState<{ dataRoot?: string } | null>(null);

  const login = useMutation({
    mutationFn: () => api.login({ username, password }),
    onSuccess: async (result) => {
      if ("mfaRequired" in result && result.mfaRequired) {
        setMfaToken(result.mfaToken);
        setTotpCode("");
        setView("totp");
        setError(null);
        return;
      }
      await qc.invalidateQueries({ queryKey: ["me"] });
    },
    onError: (err: Error) => setError(err.message?.trim() || SIGN_IN_FALLBACK),
  });

  const loginTotp = useMutation({
    mutationFn: () => api.loginTotp({ mfaToken, code: totpCode }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["me"] });
    },
    onError: (err: Error) => {
      const msg = err.message?.trim();
      setError(msg === "invalid_totp" || !msg ? TOTP_FAIL : msg);
    },
  });

  const startReset = useMutation({
    mutationFn: () => api.startPasswordReset({ username }),
    onSuccess: (result) => {
      setResetHint({ dataRoot: result.dataRoot });
      setError(null);
      if (result.methods.includes("host_file") && result.methods.includes("totp")) {
        setView("reset-pick");
      } else if (result.methods.includes("totp") && !result.methods.includes("host_file")) {
        setView("reset-totp");
      } else {
        setView("reset-code");
      }
    },
    onError: (err: Error) => setError(err.message?.trim() || "Couldn't start a password reset."),
  });

  const completeReset = useMutation({
    mutationFn: () => {
      const totpTrim = totpCode.trim();
      const totpLooksLikeCode = /^\d{6}$/.test(totpTrim.replace(/\s/g, ""));
      return api.completePasswordReset({
        username,
        password: newPassword,
        ...(view === "reset-totp"
          ? totpLooksLikeCode
            ? { totpCode: totpTrim }
            : { backupCode: totpTrim }
          : { hostFileCode: code }),
      });
    },
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["me"] });
    },
    onError: (err: Error) => {
      const msg = err.message?.trim();
      setError(msg === "invalid_reset" || !msg ? RESET_FAIL_FALLBACK : msg);
    },
  });

  function onLogin(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (!username.trim() || !password) {
      setError(SIGN_IN_FALLBACK);
      return;
    }
    login.mutate();
  }

  function onTotp(e: FormEvent) {
    e.preventDefault();
    setError(null);
    loginTotp.mutate();
  }

  function onStartReset(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (!username.trim()) {
      setError("Enter the username for this host.");
      return;
    }
    startReset.mutate();
  }

  function onCompleteReset(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (view === "reset-code" && !code.trim()) {
      setError(RESET_FAIL_FALLBACK);
      return;
    }
    if (view === "reset-totp" && !totpCode.trim()) {
      setError(TOTP_FAIL);
      return;
    }
    if (newPassword !== confirmPassword) {
      setError("Passwords don't match.");
      return;
    }
    completeReset.mutate();
  }

  function backToLogin() {
    setView("login");
    setError(null);
    setCode("");
    setTotpCode("");
    setMfaToken("");
    setNewPassword("");
    setConfirmPassword("");
    setResetHint(null);
  }

  const errorId = "login-error";
  const pending = login.isPending || loginTotp.isPending || startReset.isPending || completeReset.isPending;
  const resetPath = resetHint?.dataRoot
    ? `${resetHint.dataRoot.replace(/[\\/]+$/, "")}${resetHint.dataRoot.includes("\\") ? "\\" : "/"}password-reset.txt`
    : null;

  return (
    <div className="auth-screen">
      {view === "login" ? (
        <form className="auth-panel" onSubmit={onLogin}>
          <header className="auth-brand">
            <h1 className="brand-mark">
              Play<span>On</span>
            </h1>
            <p className="lede">Sign in to run servers for the night.</p>
          </header>
          <label className="field">
            <span>Username</span>
            <input
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              required
              autoComplete="username"
              autoFocus
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
              autoComplete="current-password"
              disabled={pending}
              aria-invalid={Boolean(error) || undefined}
              aria-describedby={error ? errorId : undefined}
            />
          </label>
          {error ? (
            <p className="error" id={errorId} role="alert">
              {error}
            </p>
          ) : null}
          <button className="btn btn-primary" type="submit" disabled={pending}>
            {login.isPending ? "Signing in…" : "Sign in"}
          </button>
          <button
            className="auth-text-action"
            type="button"
            disabled={pending}
            onClick={() => {
              setView("reset-start");
              setError(null);
            }}
          >
            Forgot password?
          </button>
          <p className="muted auth-foot">
            Players join at <Link to="/play">/play</Link> on this host (e.g. playon.local/play) — no
            account needed.
          </p>
        </form>
      ) : null}

      {view === "totp" ? (
        <form className="auth-panel" onSubmit={onTotp}>
          <header className="auth-brand">
            <h1 className="brand-mark">
              Play<span>On</span>
            </h1>
            <p className="lede">Enter the code from your authenticator app.</p>
          </header>
          <label className="field">
            <span>Authenticator or backup code</span>
            <input
              value={totpCode}
              onChange={(e) => setTotpCode(e.target.value)}
              required
              autoComplete="one-time-code"
              autoFocus
              spellCheck={false}
              disabled={pending}
            />
          </label>
          {error ? (
            <p className="error" id={errorId} role="alert">
              {error}
            </p>
          ) : null}
          <button className="btn btn-primary" type="submit" disabled={pending}>
            {loginTotp.isPending ? "Checking…" : "Continue"}
          </button>
          <button className="auth-text-action" type="button" disabled={pending} onClick={backToLogin}>
            Back to sign in
          </button>
        </form>
      ) : null}

      {view === "reset-start" ? (
        <form className="auth-panel" onSubmit={onStartReset}>
          <header className="auth-brand">
            <h1 className="brand-mark">
              Play<span>On</span>
            </h1>
            <p className="lede">Reset the password with a host file, authenticator, or backup code.</p>
          </header>
          <label className="field">
            <span>Username</span>
            <input
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              required
              autoComplete="username"
              autoFocus
              disabled={pending}
            />
          </label>
          <p className="muted status-inline">
            If host-file recovery is on, this writes <code>password-reset.txt</code> on the PlayOn
            machine. Authenticator recovery uses the 6-digit app code or a backup code.
          </p>
          {error ? (
            <p className="error" id={errorId} role="alert">
              {error}
            </p>
          ) : null}
          <button className="btn btn-primary" type="submit" disabled={pending}>
            {startReset.isPending ? "Starting…" : "Continue"}
          </button>
          <button className="auth-text-action" type="button" disabled={pending} onClick={backToLogin}>
            Back to sign in
          </button>
        </form>
      ) : null}

      {view === "reset-pick" ? (
        <div className="auth-panel">
          <header className="auth-brand">
            <h1 className="brand-mark">
              Play<span>On</span>
            </h1>
            <p className="lede">How do you want to prove it&apos;s you?</p>
          </header>
          <button className="btn btn-primary" type="button" onClick={() => setView("reset-totp")}>
            Authenticator or backup code
          </button>
          <button className="btn btn-ghost" type="button" onClick={() => setView("reset-code")}>
            Host file code
          </button>
          <button className="auth-text-action" type="button" onClick={backToLogin}>
            Back to sign in
          </button>
        </div>
      ) : null}

      {view === "reset-code" ? (
        <form className="auth-panel" onSubmit={onCompleteReset}>
          <header className="auth-brand">
            <h1 className="brand-mark">
              Play<span>On</span>
            </h1>
            <p className="lede">Read the code from this host, then choose a new password.</p>
          </header>
          <ol className="auth-steps">
            <li>
              On the computer that runs PlayOn, open <code>password-reset.txt</code> in the data
              directory.
            </li>
            <li>
              Windows Home is usually <code>%LOCALAPPDATA%\PlayOn\data</code>. Linux Home is{" "}
              <code>~/playon/data</code>, or <code>PLAYON_DATA_ROOT</code> in{" "}
              <code>/etc/playon/playon.env</code>.
            </li>
            <li>Paste the code below. It expires in 15 minutes and works once.</li>
          </ol>
          {resetPath ? (
            <p className="field-hint">
              This browser is on the host. Exact file: <code>{resetPath}</code>
            </p>
          ) : null}
          <label className="field">
            <span>Username</span>
            <input value={username} readOnly autoComplete="username" />
          </label>
          <label className="field">
            <span>Host file code</span>
            <input
              value={code}
              onChange={(e) => setCode(e.target.value)}
              required
              autoComplete="one-time-code"
              autoFocus
              spellCheck={false}
              disabled={pending}
            />
          </label>
          <NewPasswordFields
            newPassword={newPassword}
            confirmPassword={confirmPassword}
            setNewPassword={setNewPassword}
            setConfirmPassword={setConfirmPassword}
            pending={pending}
            error={error}
          />
          {error ? (
            <p className="error" id={errorId} role="alert">
              {error}
            </p>
          ) : null}
          <button className="btn btn-primary" type="submit" disabled={pending}>
            {completeReset.isPending ? "Saving…" : "Set new password"}
          </button>
          <button className="auth-text-action" type="button" disabled={pending} onClick={backToLogin}>
            Back to sign in
          </button>
        </form>
      ) : null}

      {view === "reset-totp" ? (
        <form className="auth-panel" onSubmit={onCompleteReset}>
          <header className="auth-brand">
            <h1 className="brand-mark">
              Play<span>On</span>
            </h1>
            <p className="lede">Enter an authenticator or backup code, then choose a new password.</p>
          </header>
          <label className="field">
            <span>Username</span>
            <input value={username} readOnly autoComplete="username" />
          </label>
          <label className="field">
            <span>Authenticator or backup code</span>
            <input
              value={totpCode}
              onChange={(e) => setTotpCode(e.target.value)}
              required
              autoComplete="one-time-code"
              autoFocus
              spellCheck={false}
              disabled={pending}
            />
          </label>
          <NewPasswordFields
            newPassword={newPassword}
            confirmPassword={confirmPassword}
            setNewPassword={setNewPassword}
            setConfirmPassword={setConfirmPassword}
            pending={pending}
            error={error}
          />
          {error ? (
            <p className="error" id={errorId} role="alert">
              {error}
            </p>
          ) : null}
          <button className="btn btn-primary" type="submit" disabled={pending}>
            {completeReset.isPending ? "Saving…" : "Set new password"}
          </button>
          <button className="auth-text-action" type="button" disabled={pending} onClick={backToLogin}>
            Back to sign in
          </button>
        </form>
      ) : null}
    </div>
  );
}

function NewPasswordFields({
  newPassword,
  confirmPassword,
  setNewPassword,
  setConfirmPassword,
  pending,
  error,
}: {
  newPassword: string;
  confirmPassword: string;
  setNewPassword: (value: string) => void;
  setConfirmPassword: (value: string) => void;
  pending: boolean;
  error: string | null;
}) {
  return (
    <>
      <label className="field">
        <span>New password</span>
        <input
          type="password"
          value={newPassword}
          onChange={(e) => setNewPassword(e.target.value)}
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
    </>
  );
}
