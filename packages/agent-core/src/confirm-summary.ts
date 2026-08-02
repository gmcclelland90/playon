/** Human-readable action phrases for gated tools. */
const TOOL_ACTIONS: Record<string, string> = {
  servers_stop: "stop this server",
  servers_restart: "restart this server",
  servers_delete: "permanently delete this server",
  servers_relocate: "move this server to another machine",
  servers_import_local: "import a server from a local folder",
  servers_import_sftp: "import a server over SFTP",
  snapshot_restore: "restore this server from a snapshot",
  backup_offnode_restore: "restore this server from an off-site backup",
  fs_write: "change a server file",
  skill_promote: "promote a draft skill so it can be installed",
  skill_import: "import a skill package",
  skill_promote_server: "add a server skill to the shared library",
  steamcmd_app_update: "download or update game files via Steam",
};

function asNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function clip(text: string, max = 80): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function humanizeToolName(toolName: string): string {
  const spaced = toolName.replace(/_/g, " ").trim();
  return spaced ? `run "${spaced}"` : "run a privileged action";
}

function detailFor(toolName: string, args: Record<string, unknown>): string | undefined {
  const path =
    asNonEmptyString(args.path) ??
    asNonEmptyString(args.sourcePath) ??
    asNonEmptyString(args.zipPath);
  const skill =
    asNonEmptyString(args.skillName) ??
    asNonEmptyString(args.slug) ??
    asNonEmptyString(args.name);
  const label = asNonEmptyString(args.label);
  const appId = asNonEmptyString(args.appId) ?? (typeof args.appId === "number" ? String(args.appId) : undefined);
  const message = asNonEmptyString(args.message);

  switch (toolName) {
    case "fs_write":
      return path ? clip(path) : undefined;
    case "servers_import_local":
    case "servers_import_sftp":
    case "skill_import":
      return path ? clip(path) : undefined;
    case "skill_promote":
    case "skill_promote_server":
      return skill ? clip(skill) : undefined;
    case "steamcmd_app_update":
      return appId ? `app ${clip(appId)}` : undefined;
    case "snapshot_restore":
      return label ? clip(label) : undefined;
    case "servers_relocate": {
      const target = asNonEmptyString(args.targetNodeId) ?? asNonEmptyString(args.nodeId);
      return target ? `to ${clip(target)}` : undefined;
    }
    default: {
      const fallback = path ?? skill ?? label ?? message;
      return fallback ? clip(fallback) : undefined;
    }
  }
}

/** Short host-facing confirmation copy (no raw JSON dumps). */
export function confirmSummary(toolName: string, args: Record<string, unknown>): string {
  const action = TOOL_ACTIONS[toolName] ?? humanizeToolName(toolName);
  const detail = detailFor(toolName, args);
  if (detail) return `An agent wants to ${action}: ${detail}`;
  return `An agent wants to ${action}.`;
}

/** Short label for “always allow this” UI (verb phrase without “An agent wants to”). */
export function confirmActionLabel(toolName: string): string {
  return TOOL_ACTIONS[toolName] ?? humanizeToolName(toolName);
}
