import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../api";

export function McpAccessTokensSection() {
  const qc = useQueryClient();
  const tokens = useQuery({ queryKey: ["access-tokens"], queryFn: api.listAccessTokens });
  const [name, setName] = useState("Cursor / Claude / Codex");
  const [autoApprove, setAutoApprove] = useState(false);
  const [createdPlaintext, setCreatedPlaintext] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const mcpUrl =
    typeof window !== "undefined" ? `${window.location.origin}/mcp` : "http://playon.local/mcp";

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
    <section className="panel stack tight settings-section" id="settings-mcp">
      <h3 className="section-title">External agents (MCP)</h3>
      <p className="muted status-inline">
        Connect Claude Code, Codex, Cursor, OpenClaw, Hermes, or other MCP clients with a PlayOn
        access token. Your agent can set up servers end-to-end and manage them afterward — same tools
        as in-app agents. No cloud LLM key required on this host.{" "}
        <a href="https://playon.games/docs/mcp" target="_blank" rel="noreferrer">
          Setup guides
        </a>
      </p>
      <div className="settings-two-col">
        <div className="stack tight">
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
        </div>
        <div className="stack tight">
          <p className="section-label">Active tokens</p>
          {tokens.isLoading ? (
            <p className="muted">Loading tokens…</p>
          ) : tokens.data?.tokens.length ? (
            <ul className="list compact-list">
              {tokens.data.tokens.map((t) => (
                <li key={t.id}>
                  <div>
                    <strong>{t.name}</strong>
                    <div className="muted">
                      {t.autoApproveConfirms ? "auto-approve · " : ""}
                      {new Date(t.createdAt).toLocaleString()}
                    </div>
                  </div>
                  <button
                    className="btn btn-danger btn-compact"
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
        </div>
      </div>
    </section>
  );
}
