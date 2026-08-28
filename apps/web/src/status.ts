/** Process-up is not joinable unless the advertised join path was proven. */
export function displayServerStatus(status: string, ready?: boolean | null): string {
  if (status === "running" && ready !== true) return "degraded";
  return status;
}

/** Human labels + short guidance for server/runtime status strings. */
export function statusLabel(status: string): string {
  switch (status) {
    case "running":
      return "Running";
    case "degraded":
      return "Not joinable";
    case "stopped":
      return "Stopped";
    case "starting":
      return "Starting";
    case "stopping":
      return "Stopping";
    case "error":
    case "failed":
      return "Failed";
    case "docker_unavailable":
      return "Docker missing";
    case "online":
      return "Online";
    case "stale":
      return "Stale";
    case "offline":
      return "Offline";
    case "pending_setup":
      return "Pending setup";
    case "unknown":
      return "Unknown";
    default:
      return status.replace(/_/g, " ");
  }
}

/** Never-heartbeated placeholder from Add node / one-liner. */
export function isPendingNodeSetup(opts: {
  agentVersion?: string | null;
  status: string;
}): boolean {
  // agentVersion stays "pending" until first heartbeat; ignore presence age.
  void opts.status;
  return opts.agentVersion === "pending";
}

/** Display presence for node lists (pending setup overrides offline). */
export function nodePresenceLabel(opts: {
  status: string;
  agentVersion?: string | null;
}): string {
  if (isPendingNodeSetup(opts)) return statusLabel("pending_setup");
  return statusLabel(opts.status);
}

/** Hint when a node row is not heartbeating (especially Local without playon-node). */
export function nodePresenceHint(opts: {
  id: string;
  status: string;
  agentVersion?: string | null;
}): string | null {
  if (isPendingNodeSetup(opts)) {
    return "Bootstrap never finished — Remove this entry and retry Add via SSH, or run the one-liner with sudo on the target host.";
  }
  if (opts.status !== "offline" && opts.status !== "stale") return null;
  if (opts.id === "local") {
    return "Local node-agent is not heartbeating — enable playon-node (systemctl enable --now playon-node) or run the node-agent against this API.";
  }
  return "No recent heartbeat — check the node-agent service and PLAYON_NODE_TOKEN on that host.";
}

export function statusHint(status: string): string | null {
  switch (status) {
    case "starting":
      return "Usually under a minute.";
    case "stopping":
      return "Waiting for the process to exit.";
    case "error":
    case "failed":
      return "Ask the agents in chat, or check Dashboard activity.";
    case "degraded":
      return "Process is up but the advertised join address is not reachable.";
    case "stopped":
      return "Start when players are ready.";
    case "docker_unavailable":
      return "Docker missing on this node — Settings → Nodes → Install Docker.";
    default:
      return null;
  }
}

/** Map raw error / tool messages to short host-facing guidance. */
export function runtimeErrorHint(message: string | null | undefined): string | null {
  if (!message) return null;
  const m = message.toLowerCase();
  if (m.includes("docker_unavailable") || m.includes("docker unavailable")) {
    return "Docker missing on this node — Settings → Nodes → Install Docker.";
  }
  if (m.includes("no_eligible_node") || m.includes("os_mismatch") || m.includes("node_ineligible")) {
    return "No suitable node for this game — Settings → Nodes → add a Linux machine (or enable a Linux runtime on Windows when available).";
  }
  if (m.includes("no_container_image")) {
    return "This skill needs a container image. Install the skill from the catalog, or pick a native skill.";
  }
  if (m.includes("node_token_unset")) {
    return "Set PLAYON_NODE_TOKEN on the control plane (same value on each node-agent), then restart PlayOn. Home install sets this automatically.";
  }
  if (m.includes("ssh_auth_failed") || m.includes("all configured authentication methods failed")) {
    return "SSH login failed — check the username and password (or key), then try again.";
  }
  if (m.includes("ssh_needs_root_or_sudo")) {
    return "Install needs root on the target host. Use the root user, or a user with passwordless sudo / sudo unlocked by this SSH password.";
  }
  if (m.includes("ssh_bootstrap_failed") || m.includes("ssh_install_docker_failed")) {
    return "Remote install failed — check the error detail, fix the host, Remove any pending node, and retry.";
  }
  if (m.includes("ssh_timeout")) {
    return "SSH timed out — check the host address, port 22, and that the machine is reachable from Home.";
  }
  if (m.includes("node_has_servers")) {
    return "This node still has servers. Move or delete them first, or Force remove to drop the node record anyway.";
  }
  if (m.includes("manage_scan_roots_missing")) {
    return "Scan paths aren’t installed on Home — the agent needs import-scan-roots.yaml beside skills. Sync skills from the PlayOn checkout, then Rescan.";
  }
  if (m.includes("manage_cutover_local_unreachable")) {
    return "Couldn’t reach this host to finish Manage. Check the node is Online, then try again.";
  }
  return null;
}

/** Short label for dense rails/crates; keeps full name for title/tooltip. */
export function shortDisplayName(name: string, max = 22): string {
  const trimmed = name.trim();
  if (trimmed.length <= max) return trimmed;
  // lab-matrix-stormworks-mslmnas5 → stormworks
  const parts = trimmed.split(/[-_]/).filter(Boolean);
  if (parts.length >= 3) {
    const noise = new Set(["lab", "matrix", "playon", "test", "tmp"]);
    const meaningful = parts.filter((p, i) => {
      if (noise.has(p.toLowerCase())) return false;
      // Drop trailing hash-like tokens (mslmnas5).
      if (i === parts.length - 1 && /^[a-z]*\d+[a-z0-9]*$/i.test(p) && p.length <= 12) {
        return false;
      }
      return true;
    });
    const mid = meaningful.join("-");
    if (mid.length >= 3 && mid.length <= max) return mid;
  }
  // Prefer a hyphen / underscore / space break over mid-word cut
  // (expedition-spacetime → expedition…, not expedition-spacet…).
  const slice = trimmed.slice(0, max);
  const breakAt = Math.max(slice.lastIndexOf("-"), slice.lastIndexOf("_"), slice.lastIndexOf(" "));
  if (breakAt >= Math.floor(max * 0.45)) {
    return `${trimmed.slice(0, breakAt)}…`;
  }
  return `${trimmed.slice(0, Math.max(1, max - 1))}…`;
}
