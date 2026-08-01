import { useState, type FormEvent } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";

export function SetupPage() {
  const qc = useQueryClient();
  const [username, setUsername] = useState("host");
  const [displayName, setDisplayName] = useState("LAN Host");
  const [password, setPassword] = useState("");
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
    mutation.mutate();
  }

  return (
    <div className="auth-screen">
      <form className="auth-panel" onSubmit={onSubmit}>
        <div>
          <h1 className="brand-mark">
            Play<span>On</span>
          </h1>
          <p className="lede">Create the Owner account for this LAN control plane.</p>
        </div>
        <label className="field">
          <span>Username</span>
          <input value={username} onChange={(e) => setUsername(e.target.value)} required minLength={3} autoComplete="username" />
        </label>
        <label className="field">
          <span>Display name</span>
          <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} required />
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
          />
        </label>
        {error ? <p className="error">{error}</p> : null}
        <button className="btn btn-primary" type="submit" disabled={mutation.isPending}>
          {mutation.isPending ? "Creating…" : "Create Owner"}
        </button>
      </form>
    </div>
  );
}
