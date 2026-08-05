import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { PublicUser } from "@playon/shared";
import { api } from "../api";
import { playonSocket } from "../ws";

const DISMISS_KEY = "playon.updateBanner.dismissedVersion";

export function UpdateBanner({ user }: { user: PublicUser }) {
  const qc = useQueryClient();
  const [dismissedFor, setDismissedFor] = useState<string | null>(() => {
    try {
      return sessionStorage.getItem(DISMISS_KEY);
    } catch {
      return null;
    }
  });
  const [progress, setProgress] = useState<string | null>(null);

  const updates = useQuery({
    queryKey: ["updates"],
    queryFn: () => api.updatesStatus(false),
    enabled: user.role === "owner" || user.role === "admin",
    refetchInterval: 15 * 60_000,
  });

  useEffect(() => {
    playonSocket.connect();
    return playonSocket.subscribe((ev) => {
      if (ev.type !== "update.progress") return;
      if (ev.target === "home") {
        setProgress(ev.message);
        void qc.invalidateQueries({ queryKey: ["updates"] });
      }
    });
  }, [qc]);

  const apply = useMutation({
    mutationFn: api.applyHomeUpdate,
    onError: (err) => setProgress((err as Error).message),
    onSuccess: () => {
      setProgress("Restarting… reconnecting shortly");
    },
  });

  const status = updates.data;
  if (!status?.homeUpdateAvailable || !status.latestVersion) return null;
  if (dismissedFor === status.latestVersion) return null;
  if (user.role !== "owner" && user.role !== "admin") return null;

  return (
    <div className="update-banner" role="status">
      <div className="update-banner-copy">
        <strong>Update available</strong>
        <span className="muted">
          {" "}
          {status.currentVersion} → {status.latestVersion}
          {status.notesUrl ? (
            <>
              {" · "}
              <a href={status.notesUrl} target="_blank" rel="noreferrer">
                What’s new
              </a>
            </>
          ) : null}
        </span>
        {progress || status.applyMessage ? (
          <div className="muted status-inline">{progress || status.applyMessage}</div>
        ) : null}
      </div>
      <div className="btn-row">
        {user.role === "owner" ? (
          <button
            type="button"
            className="btn btn-primary"
            disabled={apply.isPending || status.applying}
            onClick={() => {
              setProgress("Starting update…");
              apply.mutate();
            }}
          >
            {apply.isPending || status.applying ? "Updating…" : "Update & restart"}
          </button>
        ) : null}
        <button
          type="button"
          className="btn"
          onClick={() => {
            try {
              sessionStorage.setItem(DISMISS_KEY, status.latestVersion!);
            } catch {
              // ignore
            }
            setDismissedFor(status.latestVersion);
          }}
        >
          Later
        </button>
      </div>
    </div>
  );
}
