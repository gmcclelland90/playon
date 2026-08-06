import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";

type Candidate = {
  path: string;
  hintIds: string[];
  suggestedGame?: string;
  suggestedSkillName?: string;
};

export function MapImportSuggestPanel({
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
  const [importingPath, setImportingPath] = useState<string | null>(null);

  const suggest = useQuery({
    queryKey: ["import-suggest", nodeId],
    queryFn: () => api.suggestNodeImport(nodeId),
    staleTime: 15_000,
    retry: 1,
  });

  useEffect(() => {
    setNotice(null);
    setImportingPath(null);
  }, [nodeId]);

  const importMut = useMutation({
    mutationFn: (c: Candidate) =>
      api.importFromNode(nodeId, {
        sourcePath: c.path,
        serverName: c.suggestedGame,
        skillName: c.suggestedSkillName,
      }),
    onMutate: (c) => {
      setImportingPath(c.path);
      setNotice(null);
    },
    onSuccess: async (res) => {
      setImportingPath(null);
      setNotice(`Imported “${res.import.server.name}” onto this pad.`);
      await qc.invalidateQueries({ queryKey: ["servers"] });
      await qc.invalidateQueries({ queryKey: ["import-suggest", nodeId] });
    },
    onError: (err) => {
      setImportingPath(null);
      setNotice(err instanceof Error ? err.message : "Import failed");
    },
  });

  const candidates = suggest.data?.candidates ?? [];

  return (
    <div className="map-add-node-panel" role="dialog" aria-label={`Scan ${nodeName}`}>
      <div className="dash-section-head">
        <h3>Scan · {nodeName}</h3>
        <button type="button" className="linkish" onClick={onClose}>
          Close
        </button>
      </div>
      <p className="muted small">
        Look for known install roots on this host. Confirm before importing into PlayOn.
      </p>

      {suggest.isLoading ? <p className="muted">Scanning…</p> : null}
      {suggest.isError ? (
        <p className="error-text">
          {suggest.error instanceof Error ? suggest.error.message : "Scan failed"}
        </p>
      ) : null}

      {!suggest.isLoading && !suggest.isError && candidates.length === 0 ? (
        <p className="muted">No matching servers under allowlisted paths.</p>
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
                disabled={importMut.isPending}
                onClick={() => {
                  if (
                    window.confirm(
                      `Import “${c.suggestedGame ?? c.path}” into PlayOn on ${nodeName}?`,
                    )
                  ) {
                    importMut.mutate(c);
                  }
                }}
              >
                {importingPath === c.path ? "Importing…" : "Import"}
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      <div className="btn-row">
        <button
          type="button"
          className="secondary"
          disabled={suggest.isFetching}
          onClick={() => void suggest.refetch()}
        >
          {suggest.isFetching ? "Scanning…" : "Rescan"}
        </button>
      </div>

      {notice ? <p className="muted small">{notice}</p> : null}
    </div>
  );
}
