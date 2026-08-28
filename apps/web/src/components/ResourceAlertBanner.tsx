import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { ResourceAlert } from "@playon/shared";
import { api } from "../api";
import { playonSocket } from "../ws";

const DISMISS_KEY = "playon.resourceAlerts.dismissed";

function loadDismissed(): Set<string> {
  try {
    const raw = sessionStorage.getItem(DISMISS_KEY);
    const list = raw ? (JSON.parse(raw) as string[]) : [];
    return new Set(Array.isArray(list) ? list : []);
  } catch {
    return new Set();
  }
}

function alertKey(a: ResourceAlert): string {
  return [a.kind, a.scope, a.nodeId, a.serverId ?? "", a.tone].join(":");
}

export function ResourceAlertBanner() {
  const qc = useQueryClient();
  const [dismissed, setDismissed] = useState<Set<string>>(loadDismissed);
  const nodes = useQuery({
    queryKey: ["nodes"],
    queryFn: api.nodes,
    refetchInterval: 15_000,
  });

  useEffect(() => {
    playonSocket.connect();
    return playonSocket.subscribe((ev) => {
      if (ev.type === "node.metrics" || ev.type === "node.heartbeat") {
        void qc.invalidateQueries({ queryKey: ["nodes"] });
        void qc.invalidateQueries({ queryKey: ["servers"] });
      }
    });
  }, [qc]);

  const alerts = useMemo(() => {
    const list = (nodes.data?.nodes ?? []).flatMap((n) => n.alerts ?? []);
    const danger = list.filter((a) => a.tone === "danger");
    const warn = list.filter((a) => a.tone === "warn" && !dismissed.has(alertKey(a)));
    return [...danger, ...warn];
  }, [nodes.data, dismissed]);

  if (!alerts.length) return null;
  const lead = alerts[0]!;
  const worst = alerts.some((a) => a.tone === "danger") ? "danger" : "warn";
  const extra = alerts.length - 1;

  return (
    <div className={`resource-alert-banner tone-${worst}`} role="alert">
      <p className="resource-alert-copy">
        {lead.message}
        {extra > 0 ? <span className="muted"> · {extra} more</span> : null}
      </p>
      <div className="btn-row">
        <Link className="btn btn-ghost btn-compact" to="/settings#settings-nodes">
          Nodes
        </Link>
        {worst === "warn" ? (
          <button
            type="button"
            className="btn btn-ghost btn-compact"
            onClick={() => {
              const next = new Set(dismissed);
              for (const a of alerts) next.add(alertKey(a));
              try {
                sessionStorage.setItem(DISMISS_KEY, JSON.stringify([...next]));
              } catch {
                /* ignore */
              }
              setDismissed(next);
            }}
          >
            Later
          </button>
        ) : null}
      </div>
    </div>
  );
}
