import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { runtimeErrorHint } from "../status";

type Candidate = {
  path: string;
  hintIds: string[];
  suggestedGame?: string;
  suggestedSkillName?: string;
};

function scanErrorMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : "Scan failed";
  return runtimeErrorHint(raw) ?? raw;
}

export function MapManageSuggestPanel({
  nodeId,
  nodeName,
  onClose,
}: {
  nodeId: string;
  nodeName: string;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [notice, setNotice] = useState<string | null>(null);
  const [managingPath, setManagingPath] = useState<string | null>(null);
  const [showCutoverHelp, setShowCutoverHelp] = useState(false);
  const [pendingManage, setPendingManage] = useState<Candidate | null>(null);

  const suggest = useQuery({
    queryKey: ["manage-suggest", nodeId],
    queryFn: () => api.suggestNodeManage(nodeId),
    staleTime: 15_000,
    retry: 1,
  });

  useEffect(() => {
    setNotice(null);
    setManagingPath(null);
    setShowCutoverHelp(false);
    setPendingManage(null);
  }, [nodeId]);

  const manageMut = useMutation({
    mutationFn: (c: Candidate) =>
      api.manageFromNode(nodeId, {
        sourcePath: c.path,
        serverName: c.suggestedGame,
        skillName: c.suggestedSkillName,
        game: c.suggestedGame,
        hintIds: c.hintIds,
      }),
    onMutate: (c) => {
      setManagingPath(c.path);
      setPendingManage(null);
      setNotice(null);
    },
    onSuccess: async (res) => {
      setManagingPath(null);
      setNotice(
        `“${res.manage.server.name}” is on this pad (stopped). Stop the old host service, then Start here.`,
      );
      await qc.invalidateQueries({ queryKey: ["servers"] });
      await qc.invalidateQueries({ queryKey: ["manage-suggest", nodeId] });
    },
    onError: (err) => {
      setManagingPath(null);
      setNotice(scanErrorMessage(err));
    },
  });

  const candidates = suggest.data?.candidates ?? [];
  const rootsMissing =
    suggest.isError &&
    suggest.error instanceof Error &&
    suggest.error.message.includes("manage_scan_roots_missing");

  return (
    <div className="map-add-node-panel" role="dialog" aria-label={`Scan ${nodeName}`}>
      <div className="dash-section-head">
        <h3>Scan for installs · {nodeName}</h3>
        <div className="btn-row">
          <button
            type="button"
            className="btn btn-primary btn-compact"
            disabled={suggest.isFetching}
            onClick={() => void suggest.refetch()}
          >
            {suggest.isFetching ? "Scanning…" : "Rescan"}
          </button>
          <button type="button" className="linkish" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
      <p className="muted small">
        Find game installs already on this host and bring them under PlayOn on the same machine.
      </p>

      <details
        className="map-scan-cutover"
        open={showCutoverHelp}
        onToggle={(e) => setShowCutoverHelp((e.target as HTMLDetailsElement).open)}
      >
        <summary>How cutover works</summary>
        <p className="muted small">
          PlayOn copies the install into its own server directory on that host (and for known games,
          pulls external world/config into a per-server HOME). The original stays as a fallback —
          nothing is hauled to Home. Starting under PlayOn is a cutover: stop any existing host
          service first; players need a maintenance window.
        </p>
      </details>

      {suggest.isLoading ? <p className="muted">Scanning…</p> : null}
      {suggest.isError ? (
        <div className="map-scan-error" role="alert">
          <p className="error-text">{scanErrorMessage(suggest.error)}</p>
          {rootsMissing ? (
            <p className="muted small">
              After skills are synced on Home, Rescan. Settings → Nodes if this host still looks
              offline.
            </p>
          ) : null}
        </div>
      ) : null}

      {!suggest.isLoading && !suggest.isError && candidates.length === 0 ? (
        <p className="muted">
          No game installs found in the scan folders on this host. Rescan after installs land under
          Steam/common or ~/servers.
        </p>
      ) : null}

      {candidates.length > 0 ? (
        <ul className="map-import-suggest-list">
          {candidates.map((c) => (
            <li key={c.path}>
              <div>
                <strong>{c.suggestedGame ?? "Unknown game"}</strong>
                <div className="muted small mono">{c.path}</div>
                {c.suggestedSkillName ? (
                  <div className="muted small">{c.suggestedSkillName}</div>
                ) : null}
              </div>
              <button
                type="button"
                disabled={manageMut.isPending}
                onClick={() => setPendingManage(c)}
              >
                {managingPath === c.path ? "Adding…" : "Manage"}
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      {pendingManage ? (
        <div className="map-inline-confirm map-inline-confirm-nested" role="alertdialog">
          <p>
            Manage “{pendingManage.suggestedGame ?? pendingManage.path}” with PlayOn on {nodeName}?
          </p>
          <p className="muted small">
            Copies the install into PlayOn’s jail on this host. Stop the old process yourself before
            Start. Cutover needs downtime.
          </p>
          <div className="btn-row">
            <button type="button" className="btn btn-ghost" onClick={() => setPendingManage(null)}>
              Cancel
            </button>
            <button
              type="button"
              className="btn btn-primary"
              disabled={manageMut.isPending}
              onClick={() => manageMut.mutate(pendingManage)}
            >
              Manage
            </button>
          </div>
        </div>
      ) : null}

      {notice ? <p className="muted small">{notice}</p> : null}
    </div>
  );
}
