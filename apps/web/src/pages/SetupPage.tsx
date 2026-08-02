import { useState, type FormEvent } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";

export function SetupPage() {
  const qc = useQueryClient();
  const [username, setUsername] = useState("host");
  const [displayName, setDisplayName] = useState("LAN Host");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: () => api.bootstrapOwner({ username, password, displayName }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["setup"] });
      await qc.invalidateQueries({ queryKey: ["me"] });
    },
    onError: (err: Error) => setError(err.message),
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

  return (
    <div className="auth-screen">
      <form className="auth-panel" onSubmit={onSubmit}>
        <header className="auth-brand">
          <h1 className="brand-mark">
            Play<span>On</span>
          </h1>
          <p className="lede">Create the Owner account for this LAN control plane.</p>
        </header>
        {mutation.isSuccess ? (
          <p className="ok" role="status">
            Owner created — opening your booth…
          </p>
        ) : null}
        <label className="field">
          <span>Username</span>
          <input
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            required
            minLength={3}
            autoComplete="username"
            autoFocus
            disabled={mutation.isPending || mutation.isSuccess}
          />
        </label>
        <label className="field">
          <span>Display name</span>
          <input
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            required
            autoComplete="nickname"
            disabled={mutation.isPending || mutation.isSuccess}
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
            disabled={mutation.isPending || mutation.isSuccess}
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
            disabled={mutation.isPending || mutation.isSuccess}
            aria-invalid={error === "Passwords don't match." || undefined}
          />
        </label>
        {error ? (
          <p className="error" role="alert">
            {error}
          </p>
        ) : null}
        <button
          className="btn btn-primary"
          type="submit"
          disabled={mutation.isPending || mutation.isSuccess}
        >
          {mutation.isPending ? "Creating…" : "Create Owner"}
        </button>
        <p className="muted auth-foot">You&apos;ll land on the Map next to describe a server.</p>
      </form>
    </div>
  );
}
