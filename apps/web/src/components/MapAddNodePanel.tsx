import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { isPendingNodeSetup, runtimeErrorHint } from "../status";

type Step = "connect" | "install" | "waiting" | "online";

const STEPS: Step[] = ["connect", "install", "waiting", "online"];

function stepLabel(s: Step): string {
  switch (s) {
    case "connect":
      return "Connect";
    case "install":
      return "Install";
    case "waiting":
      return "Waiting";
    case "online":
      return "Online";
  }
}

function hintForError(message: string): { step: Step; text: string } {
  const lower = message.toLowerCase();
  const text = runtimeErrorHint(message) ?? message;
  if (lower.includes("ssh_auth") || lower.includes("authentication")) {
    return { step: "connect", text };
  }
  if (
    lower.includes("ssh_needs_root") ||
    lower.includes("ssh_bootstrap") ||
    lower.includes("sudo")
  ) {
    return { step: "install", text };
  }
  if (lower.includes("heartbeat_timeout") || lower.includes("timeout")) {
    return { step: "waiting", text };
  }
  return { step: "install", text };
}

export function MapAddNodePanel({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const nodes = useQuery({ queryKey: ["nodes"], queryFn: api.nodes, refetchInterval: 4000 });
  const [kind, setKind] = useState<"lan" | "cloud">("lan");
  const [host, setHost] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [nodeName, setNodeName] = useState("");
  const [step, setStep] = useState<Step>("connect");
  const [error, setError] = useState<string | null>(null);
  const [errorStep, setErrorStep] = useState<Step | null>(null);
  const [trackingId, setTrackingId] = useState<string | null>(null);
  const [oneLiner, setOneLiner] = useState<string | null>(null);
  const [showAdvanced, setShowAdvanced] = useState(false);

  const tokenOk = nodes.data?.nodeTokenConfigured !== false;

  useEffect(() => {
    if (!trackingId || !nodes.data?.nodes) return;
    const n = nodes.data.nodes.find((x) => x.id === trackingId);
    if (!n) return;
    if (!isPendingNodeSetup({ agentVersion: n.agentVersion, status: n.status })) {
      if (n.status === "online" || n.agentVersion) {
        setStep("online");
        setPassword("");
        window.setTimeout(() => onClose(), 1200);
      }
    } else {
      setStep("waiting");
    }
  }, [trackingId, nodes.data?.nodes, onClose]);

  const addMut = useMutation({
    mutationFn: () =>
      api.addNode({
        kind,
        host: host.trim(),
        username: username.trim(),
        password: password || undefined,
        nodeName: nodeName.trim(),
      }),
    onMutate: () => {
      setError(null);
      setErrorStep(null);
      setStep("connect");
      window.setTimeout(() => setStep("install"), 400);
    },
    onSuccess: async (res) => {
      setTrackingId(res.node.nodeId);
      await qc.invalidateQueries({ queryKey: ["nodes"] });
      if (res.node.detail === "online") {
        setStep("online");
        setPassword("");
        window.setTimeout(() => onClose(), 1200);
      } else {
        setStep("waiting");
      }
    },
    onError: (err: Error) => {
      const mapped = hintForError(err.message);
      setError(mapped.text);
      setErrorStep(mapped.step);
      setStep(mapped.step);
    },
  });

  const tokenMut = useMutation({
    mutationFn: () =>
      api.createNodeBootstrapToken({
        kind,
        nodeName: nodeName.trim() || undefined,
        endpointHost: kind === "cloud" ? host.trim() : undefined,
      }),
    onSuccess: async (res) => {
      setOneLiner(res.oneLiner);
      setTrackingId(res.nodeId);
      setStep("waiting");
      await qc.invalidateQueries({ queryKey: ["nodes"] });
    },
    onError: (err: Error) => {
      const mapped = hintForError(err.message);
      setError(mapped.text);
      setErrorStep(mapped.step);
    },
  });

  const busy = addMut.isPending || tokenMut.isPending;
  const canSubmit =
    tokenOk &&
    host.trim().length > 0 &&
    username.trim().length > 0 &&
    nodeName.trim().length > 0 &&
    Boolean(password) &&
    !busy;

  return (
    <div className="map-add-node-panel" role="dialog" aria-label="Add node">
      <div className="dash-section-head">
        <h3>Add node</h3>
        <button type="button" className="linkish" onClick={onClose}>
          Close
        </button>
      </div>
      <p className="muted status-inline">
        Install a PlayOn agent on another machine. It shows up as a host pad on this map.
      </p>

      {!tokenOk ? (
        <p className="error" role="alert">
          PLAYON_NODE_TOKEN is not set on this control plane. Add it to the PlayOn env file and
          restart before adding nodes.
        </p>
      ) : null}

      <ol className="map-add-node-steps" aria-label="Add progress">
        {STEPS.map((s) => (
          <li
            key={s}
            className={
              s === step
                ? "active"
                : STEPS.indexOf(s) < STEPS.indexOf(step)
                  ? "done"
                  : errorStep === s
                    ? "failed"
                    : ""
            }
          >
            {stepLabel(s)}
          </li>
        ))}
      </ol>

      {error ? (
        <p className="error" role="alert">
          {error}
        </p>
      ) : null}

      <div className="stack tight">
        <label className="field">
          <span>Node name</span>
          <input
            value={nodeName}
            onChange={(e) => setNodeName(e.target.value)}
            placeholder="zomboid"
            disabled={busy || !tokenOk}
            required
          />
        </label>
        <label className="field">
          <span>Where is this machine?</span>
          <select
            value={kind}
            onChange={(e) => setKind(e.target.value as "lan" | "cloud")}
            disabled={busy || !tokenOk}
          >
            <option value="lan">On my LAN</option>
            <option value="cloud">In the cloud (WireGuard)</option>
          </select>
        </label>
        <label className="field">
          <span>{kind === "cloud" ? "Public IP / hostname" : "SSH host"}</span>
          <input
            value={host}
            onChange={(e) => setHost(e.target.value)}
            placeholder={kind === "cloud" ? "203.0.113.9" : "172.16.0.109"}
            disabled={busy || !tokenOk}
          />
        </label>
        <label className="field">
          <span>SSH username</span>
          <input
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder="root or sudo user"
            disabled={busy || !tokenOk}
            autoComplete="username"
          />
        </label>
        <p className="muted status-inline">
          Non-root users need passwordless sudo, or a password that unlocks sudo on the target.
        </p>
        <label className="field">
          <span>SSH password</span>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            disabled={busy || !tokenOk}
            autoComplete="current-password"
          />
        </label>
        <div className="btn-row">
          <button
            type="button"
            className="btn btn-primary"
            disabled={!canSubmit}
            onClick={() => addMut.mutate()}
          >
            {addMut.isPending
              ? step === "waiting"
                ? "Waiting for agent…"
                : "Installing…"
              : "Add via SSH"}
          </button>
          <button
            type="button"
            className="btn"
            disabled={busy || !tokenOk || (kind === "cloud" && !host.trim()) || !nodeName.trim()}
            onClick={() => {
              setShowAdvanced(true);
              tokenMut.mutate();
            }}
          >
            One-liner instead
          </button>
        </div>
        {showAdvanced && oneLiner ? (
          <label className="field">
            <span>Run on the target machine</span>
            <textarea readOnly rows={3} value={oneLiner} />
          </label>
        ) : null}
        {step === "waiting" ? (
          <p className="muted status-inline">
            Agent installing — waiting for the first heartbeat from {nodeName || "the node"}…
          </p>
        ) : null}
        {step === "online" ? (
          <p className="muted status-inline" role="status">
            {nodeName || "Node"} is online.
          </p>
        ) : null}
      </div>
    </div>
  );
}
