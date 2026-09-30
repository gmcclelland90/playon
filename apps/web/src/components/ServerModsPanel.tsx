import { useQuery } from "@tanstack/react-query";
import { api } from "../api";

type Props = {
  serverId: string;
  onMakeMod: () => void;
};

export function ServerModsPanel({ serverId, onMakeMod }: Props) {
  const mods = useQuery({
    queryKey: ["server-mods", serverId],
    queryFn: () => api.serverMods(serverId),
    refetchInterval: 8000,
  });

  const rows = mods.data?.mods ?? [];
  const errors = mods.data?.errors ?? [];

  return (
    <section className="stack" aria-label="Authored mods">
      <div className="dash-section-head">
        <h4>Mods</h4>
        <button type="button" className="btn btn-ghost btn-compact" onClick={onMakeMod}>
          Make a mod that…
        </button>
      </div>
      <p className="muted status-inline">
        Authored in the server jail. Deploy still needs your confirm in chat.
      </p>
      {mods.isLoading ? <p className="muted">Loading mods…</p> : null}
      {mods.isError ? <p className="error">{(mods.error as Error).message || "Could not load mods."}</p> : null}
      {!mods.isLoading && !mods.isError && rows.length === 0 ? (
        <p className="muted">No authored mods yet.</p>
      ) : null}
      {rows.length > 0 ? (
        <ul className="list compact-list">
          {rows.map((row) => (
            <li key={row.modId}>
              <strong>{row.displayName}</strong>{" "}
              <span className="chip">{row.deployStatus}</span>
              <span className="muted">
                {" "}
                {row.modId} · {row.dialect} · client {row.clientNeed}
                {row.destPath ? ` · ${row.destPath}` : ""}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      {errors.length > 0 ? (
        <div className="stack">
          <strong>Errors</strong>
          <ul className="list compact-list">
            {errors.slice(0, 8).map((err, i) => (
              <li key={`${err.kind}-${i}`}>
                <span className="chip">{err.kind}</span> {err.message}
              </li>
            ))}
          </ul>
        </div>
      ) : mods.data ? (
        <p className="muted">No mod errors in recent logs.</p>
      ) : null}
    </section>
  );
}
