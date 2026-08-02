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
    default:
      return null;
  }
}
