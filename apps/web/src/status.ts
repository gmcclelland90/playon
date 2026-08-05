/** Human labels + short guidance for server/runtime status strings. */
export function statusLabel(status: string): string {
  switch (status) {
    case "running":
      return "Running";
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
    case "unknown":
      return "Unknown";
    default:
      return status.replace(/_/g, " ");
  }
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
  if (m.includes("no_container_image")) {
    return "This skill needs a container image. Install the skill from the catalog, or pick a native skill.";
  }
  return null;
}
