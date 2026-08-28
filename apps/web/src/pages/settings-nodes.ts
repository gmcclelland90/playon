/** Settings → Nodes row helpers. Header stays a nowrap name/chips | actions row; notes sit below. */

export const SETTINGS_NODE_ITEM_CLASS = "settings-node-item";
export const SETTINGS_NODE_HEADER_CLASS = "settings-node-header";
export const SETTINGS_NODE_NOTES_CLASS = "settings-node-notes";

export type StatusChipTone = "live" | "warn" | "quiet";

export type DockerChip = { label: string; tone: StatusChipTone } | null;

/**
 * Windows + an online WSL sibling with Docker is the product stance (optional Docker Desktop).
 * Do not warn-scream "No Docker" on the parent in that case.
 */
export function nodeDockerChip(opts: {
  pendingSetup: boolean;
  docker: boolean;
  isWindows: boolean;
  wslSiblingOnline: boolean;
  wslSiblingHasDocker: boolean;
}): DockerChip {
  if (opts.pendingSetup) return null;
  if (opts.docker) return { label: "Docker", tone: "live" };
  if (opts.isWindows && opts.wslSiblingOnline && opts.wslSiblingHasDocker) {
    return null;
  }
  return { label: "No Docker", tone: "warn" };
}

export type NodeUpdateJobView = {
  jobId: string;
  status: "queued" | "running" | "done" | "failed";
  progress?: string | null;
  error?: string | null;
  version?: string | null;
};

export type NodeUpdateRowMessage = {
  tone: "ok" | "muted" | "error";
  text: string;
};

/**
 * Per-row Update feedback. If Home restarted and the tracked job is gone, tell
 * the operator to press Update again instead of looking like a silent success.
 */
export function nodeUpdateRowMessage(opts: {
  job: NodeUpdateJobView | null;
  expectedJobId?: string | null;
  updateAvailable?: boolean;
}): NodeUpdateRowMessage | null {
  const job = opts.job;
  if (job) {
    if (job.status === "queued") {
      return {
        tone: "muted",
        text:
          job.progress ||
          (job.version ? `Update queued to ${job.version}…` : "Update queued…"),
      };
    }
    if (job.status === "running") {
      return { tone: "muted", text: job.progress || "Updating…" };
    }
    if (job.status === "failed") {
      return {
        tone: "error",
        text: job.error || "Update failed — press Update to retry.",
      };
    }
    if (job.status === "done") {
      return {
        tone: "ok",
        text: job.version ? `Updated to ${job.version}.` : "Update complete.",
      };
    }
  }
  if (opts.expectedJobId && !job && opts.updateAvailable) {
    return { tone: "error", text: "Queue lost — press Update again." };
  }
  return null;
}

export function nodeUpdateInFlight(job: NodeUpdateJobView | null): boolean {
  return job?.status === "queued" || job?.status === "running";
}

export { nodeUsageChips } from "../format-usage";
