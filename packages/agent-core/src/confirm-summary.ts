import { surfaceConfirmAction } from "./tool-surface.js";
import "./tool-surface-overlay.js";

function asNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function clip(text: string, max = 80): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function detailFor(toolName: string, args: Record<string, unknown>): string | undefined {
  const path =
    asNonEmptyString(args.path) ??
    asNonEmptyString(args.sourcePath) ??
    asNonEmptyString(args.zipPath) ??
    asNonEmptyString(args.destPath) ??
    asNonEmptyString(args.archivePath);
  const skill =
    asNonEmptyString(args.skillName) ??
    asNonEmptyString(args.slug) ??
    asNonEmptyString(args.name);
  const label = asNonEmptyString(args.label);
  const appId = asNonEmptyString(args.appId) ?? (typeof args.appId === "number" ? String(args.appId) : undefined);
  const message = asNonEmptyString(args.message);
  const url = asNonEmptyString(args.url);

  switch (toolName) {
    case "fs_write":
    case "fs_delete":
      return path ? clip(path) : undefined;
    case "fs_rename":
    case "fs_copy": {
      const from = asNonEmptyString(args.from);
      const to = asNonEmptyString(args.to);
      if (from && to) return clip(`${from} → ${to}`);
      return from || to ? clip(from ?? to!) : undefined;
    }
    case "archive_extract": {
      const archive = asNonEmptyString(args.archivePath);
      const dest = asNonEmptyString(args.destDir);
      if (archive && dest) return clip(`${archive} → ${dest}`);
      return archive || dest ? clip(archive ?? dest!) : undefined;
    }
    case "fetch_url":
      return url ? clip(url) : path ? clip(path) : undefined;
    case "skill_install_url": {
      const downloadUrl = asNonEmptyString(args.downloadUrl);
      return skill ? clip(skill) : downloadUrl ? clip(downloadUrl) : undefined;
    }
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
      const fallback = path ?? skill ?? label ?? message ?? url;
      return fallback ? clip(fallback) : undefined;
    }
  }
}

/** Short host-facing confirmation copy (no raw JSON dumps). */
export function confirmSummary(toolName: string, args: Record<string, unknown>): string {
  const action = surfaceConfirmAction(toolName);
  const detail = detailFor(toolName, args);
  if (detail) return `An agent wants to ${action}: ${detail}`;
  return `An agent wants to ${action}.`;
}

/** Short label for “always allow this” UI (verb phrase without “An agent wants to”). */
export function confirmActionLabel(toolName: string): string {
  return surfaceConfirmAction(toolName);
}
