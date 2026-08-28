/**
 * Human now-line for an in-flight Home agent step.
 * No raw tool names, job ids, or jail paths.
 */

const NANOIDISH = /^[A-Za-z0-9_-]{20,}$/;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type ChatProgressStep = {
  label: string;
  status: "done" | "active" | "failed";
};

export type ChatProgressPhase = "thinking" | "working" | "waiting" | "done";

/** Display names only — drop ids, paths, and secrets. */
export function friendlyNowNoun(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  if (!text || text.length > 48) return undefined;
  if (/[/\\]/.test(text)) return undefined;
  if (UUID.test(text) || NANOIDISH.test(text)) return undefined;
  if (/^(sk-|Bearer\s)/i.test(text)) return undefined;
  if (/^[0-9a-f]{16,}$/i.test(text)) return undefined;
  return text;
}

function pickArg(
  args: Record<string, unknown> | undefined,
  keys: string[],
): string | undefined {
  if (!args) return undefined;
  for (const key of keys) {
    const noun = friendlyNowNoun(args[key]);
    if (noun) return noun;
  }
  return undefined;
}

function hostNoun(args?: Record<string, unknown>): string | undefined {
  return pickArg(args, ["nodeName", "name", "host", "nodeId"]);
}

function serverNoun(args?: Record<string, unknown>): string | undefined {
  return pickArg(args, ["serverName", "name", "skillName"]);
}

function versionNoun(args?: Record<string, unknown>): string | undefined {
  return pickArg(args, ["version", "targetVersion", "agentVersion"]);
}

const TOOL_NOW: Record<string, (args?: Record<string, unknown>) => string> = {
  servers_stop: (args) => {
    const name = serverNoun(args);
    return name ? `Stopping ${name}` : "Stopping the server";
  },
  servers_start: (args) => {
    const name = serverNoun(args);
    return name ? `Starting ${name}` : "Starting the server";
  },
  servers_restart: (args) => {
    const name = serverNoun(args);
    return name ? `Restarting ${name}` : "Restarting the server";
  },
  servers_create_from_skill: (args) => {
    const name = pickArg(args, ["serverName"]);
    const skill = pickArg(args, ["skillName"]);
    if (name) return `Creating ${name}`;
    if (skill) return `Standing up ${skill}`;
    return "Creating a server";
  },
  servers_list: () => "Checking servers",
  servers_health_check: () => "Checking health",
  servers_relocate: (args) => {
    const name = serverNoun(args);
    return name ? `Moving ${name}` : "Moving the server";
  },
  servers_delete: (args) => {
    const name = serverNoun(args);
    return name ? `Removing ${name}` : "Removing the server";
  },
  servers_logs_tail: () => "Reading logs",
  servers_query: (args) => {
    const name = serverNoun(args);
    return name ? `Querying ${name}` : "Querying the server";
  },
  servers_query_test: () => "Testing the query path",
  servers_import_local: () => "Importing a local server",
  servers_import_sftp: () => "Importing over SFTP",
  node_ping: (args) => {
    const host = hostNoun(args);
    return host ? `Waiting for a heartbeat from ${host}` : "Waiting for a heartbeat";
  },
  node_fs_list: (args) => {
    const host = hostNoun(args);
    return host ? `Listing files on ${host}` : "Listing host files";
  },
  nodes_add: (args) => {
    const host = hostNoun(args);
    return host ? `Adding ${host}` : "Adding a node";
  },
  nodes_remove: (args) => {
    const host = hostNoun(args);
    return host ? `Removing ${host}` : "Removing a node";
  },
  placement_suggest: () => "Picking a host",
  skill_read: (args) => {
    const skill = pickArg(args, ["skillName"]);
    return skill ? `Reading ${skill}` : "Reading a skill";
  },
  skill_search: () => "Searching skills",
  skill_list: () => "Listing skills",
  skill_install_url: () => "Installing a skill",
  skill_promote: () => "Promoting a skill",
  skill_draft_save: () => "Saving a skill draft",
  fs_read: () => "Reading files",
  fs_list: () => "Listing files",
  fs_write: () => "Writing files",
  fs_delete: () => "Removing files",
  fs_rename: () => "Renaming files",
  fs_copy: () => "Copying files",
  archive_extract: () => "Extracting an archive",
  fetch_url: () => "Fetching a file",
  steamcmd_app_update: () => "Updating via Steam",
  panel_publish: () => "Updating the player panel",
  panel_list: () => "Checking the panel",
  panel_upsert: () => "Updating the panel",
  panel_theme: () => "Updating the panel theme",
  snapshot_create: () => "Taking a snapshot",
  snapshot_restore: () => "Restoring a snapshot",
  snapshot_list: () => "Listing snapshots",
  backup_offnode: () => "Copying a backup off-node",
  wsl_status: () => "Checking WSL",
  wsl_enable: () => "Enabling WSL",
  wsl_repair: () => "Repairing WSL",
  rcon_say: () => "Talking in-game",
  rcon_exec: () => "Running a console command",
  watchers_list: () => "Checking watchers",
  watchers_run_now: () => "Running a watcher",
  net_port_check: () => "Checking a port",
};

const PHASE_NOW: Record<string, string> = {
  thinking: "Thinking…",
  confirm_wait: "Waiting for confirm…",
  idle: "Done",
};

/** Copy-shaped node updates: version + host, without naming the OTA job. */
function updateCopyLine(args?: Record<string, unknown>): string | undefined {
  const version = versionNoun(args);
  const host = hostNoun(args);
  if (version && host) return `Copying ${version} onto ${host}`;
  if (version) return `Copying ${version}`;
  if (host) return `Updating ${host}`;
  return undefined;
}

export function nowLineForPhase(
  phase: "thinking" | "confirm_wait" | "idle" | string,
): string {
  return PHASE_NOW[phase] ?? "Working…";
}

export function nowLineForTool(
  toolName: string,
  args?: Record<string, unknown>,
): string {
  if (/update|upgrade|install/.test(toolName) && !TOOL_NOW[toolName]) {
    const copy = updateCopyLine(args);
    if (copy) return copy;
  }
  const mapped = TOOL_NOW[toolName];
  if (mapped) return mapped(args);
  if (toolName.startsWith("panel_")) return "Updating the panel";
  if (toolName.startsWith("watchers_")) return "Working on a watcher";
  if (toolName.startsWith("snapshot_") || toolName.startsWith("backup_")) {
    return "Working on a backup";
  }
  if (toolName.startsWith("skill_")) return "Working on a skill";
  if (toolName.startsWith("fs_")) return "Working with files";
  if (toolName.startsWith("servers_")) return "Working on the server";
  if (toolName.startsWith("nodes_") || toolName.startsWith("node_")) {
    return updateCopyLine(args) ?? "Working on a node";
  }
  return "Working…";
}

/** Elapsed wait so a long tool is never a still screen — real wait, not filler. */
export function formatLiveNowLine(now: string, elapsedMs: number): string {
  const label = now.trim() || "Working…";
  const sec = Math.max(0, Math.floor(elapsedMs / 1000));
  if (sec < 2) return label;
  return `${label} · ${sec}s`;
}
