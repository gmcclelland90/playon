import { useState, type FormEvent } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { api } from "../api";

const SIGN_IN_FALLBACK = "Couldn't sign in. Check username and password.";

export function LoginPage() {
  const qc = useQueryClient();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: () => api.login({ username, password }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["me"] });
    },
    onError: (err: Error) => setError(err.message?.trim() || SIGN_IN_FALLBACK),
  });

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (!username.trim() || !password) {
      setError(SIGN_IN_FALLBACK);
      return;
    }
    mutation.mutate();
  }

  const errorId = "login-error";

  return (
    <div className="auth-screen">
      <form className="auth-panel" onSubmit={onSubmit}>
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
            disabled={mutation.isPending}
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
            disabled={mutation.isPending}
            aria-invalid={Boolean(error) || undefined}
            aria-describedby={error ? errorId : undefined}
          />
        </label>
        {error ? (
          <p className="error" id={errorId} role="alert">
            {error}
          </p>
        ) : null}
        <button className="btn btn-primary" type="submit" disabled={mutation.isPending}>
          {mutation.isPending ? "Signing in…" : "Sign in"}
        </button>
        <p className="muted auth-foot">
          Players join at <Link to="/play">/play</Link> on this host (e.g. playon.local/play) — no account needed.
        </p>
      </form>
    </div>
  );
}
