import crypto from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  assertAllowedUpdateDownloadUrl,
  DEFAULT_UPDATE_MANIFEST_URL,
  deriveNodePresence,
  isNewerVersion,
  LOCAL_NODE_ID,
  UpdateManifestSchema,
  type UpdateAsset,
  type UpdateManifest,
  type UpdatePlatform,
} from "@playon/shared";
import type { Db } from "../db/client.js";
import { nodes } from "../db/schema.js";
import { findRepoRoot, type AppConfig } from "../config.js";
import type { EventHub } from "./event-hub.js";
import { readAppVersion } from "./app-version.js";
import { nodeJobService } from "./node-jobs.js";

const CACHE_TTL_MS = 60 * 60 * 1000;

export type UpdateProgressPhase =
  | "checking"
  | "downloading"
  | "verifying"
  | "applying"
  | "restarting"
  | "done"
  | "failed";

export type NodeUpdateStatus = {
  nodeId: string;
  name: string;
  os: "linux" | "windows";
  agentVersion: string;
  status: "online" | "stale" | "offline";
  updateAvailable: boolean;
  kind: string;
};

export type UpdatesStatus = {
  currentVersion: string;
  latestVersion: string | null;
  channel: string | null;
  notesUrl: string | null;
  homeUpdateAvailable: boolean;
  checkedAt: string | null;
  manifestError: string | null;
  platform: UpdatePlatform;
  applying: boolean;
  applyPhase: UpdateProgressPhase | null;
  applyMessage: string | null;
  homeCurrentEnoughForNodes: boolean;
  nodes: NodeUpdateStatus[];
};

type CacheEntry = {
  manifest: UpdateManifest;
  fetchedAt: number;
};

let cache: CacheEntry | null = null;
let applyState: {
  applying: boolean;
  phase: UpdateProgressPhase | null;
  message: string | null;
} = { applying: false, phase: null, message: null };

function setHomeApplyState(phase: UpdateProgressPhase, message: string) {
  applyState = { applying: phase !== "done" && phase !== "failed", phase, message };
}

export function resolveUpdateManifestUrl(envUrl?: string | null): string {
  return envUrl?.trim() || DEFAULT_UPDATE_MANIFEST_URL;
}

export function currentUpdatePlatform(): UpdatePlatform {
  return process.platform === "win32" ? "windows-x64" : "linux-x64";
}

export async function fetchUpdateManifest(
  manifestUrl: string = DEFAULT_UPDATE_MANIFEST_URL,
  opts?: { force?: boolean },
): Promise<UpdateManifest> {
  if (!opts?.force && cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS) {
    return cache.manifest;
  }
  const res = await fetch(manifestUrl, {
    headers: { accept: "application/json", "user-agent": "PlayOn-Home" },
  });
  if (!res.ok) {
    throw new Error(`update_manifest_fetch_failed: ${res.status}`);
  }
  const manifest = UpdateManifestSchema.parse(await res.json());
  cache = { manifest, fetchedAt: Date.now() };
  return manifest;
}

export function clearUpdateManifestCacheForTests(): void {
  cache = null;
  applyState = { applying: false, phase: null, message: null };
}

export function platformForNodeOs(osName: string): UpdatePlatform {
  return osName === "windows" ? "windows-x64" : "linux-x64";
}

export function pickAsset(
  manifest: UpdateManifest,
  kind: "home" | "node",
  platform: UpdatePlatform,
): UpdateAsset {
  const asset = manifest[kind][platform];
  if (!asset) {
    throw new Error(`update_asset_missing: ${kind}/${platform}`);
  }
  assertAllowedUpdateDownloadUrl(asset.downloadUrl);
  if (!/^[a-f0-9]{64}$/i.test(asset.sha256)) {
    throw new Error("update_asset_sha256_invalid");
  }
  return asset;
}

export async function downloadAndVerifyUpdate(opts: {
  downloadUrl: string;
  sha256: string;
  destFile: string;
  onProgress?: (phase: UpdateProgressPhase, message: string, percent?: number) => void;
}): Promise<{ bytes: number; sha256: string }> {
  assertAllowedUpdateDownloadUrl(opts.downloadUrl);
  opts.onProgress?.("downloading", "Downloading update…", 10);
  const res = await fetch(opts.downloadUrl, {
    headers: { accept: "application/octet-stream,*/*", "user-agent": "PlayOn-Home" },
  });
  if (!res.ok) throw new Error(`update_download_failed: ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  opts.onProgress?.("verifying", "Verifying checksum…", 70);
  const sha256 = crypto.createHash("sha256").update(buf).digest("hex");
  if (sha256.toLowerCase() !== opts.sha256.toLowerCase()) {
    throw new Error(`update_sha256_mismatch: expected ${opts.sha256} got ${sha256}`);
  }
  fs.mkdirSync(path.dirname(opts.destFile), { recursive: true });
  fs.writeFileSync(opts.destFile, buf);
  return { bytes: buf.length, sha256 };
}

export function extractUpdateArchive(archivePath: string, destDir: string): string {
  fs.rmSync(destDir, { recursive: true, force: true });
  fs.mkdirSync(destDir, { recursive: true });
  const isZip = archivePath.toLowerCase().endsWith(".zip");
  if (isZip) {
    if (process.platform === "win32") {
      execFileSync(
        "powershell.exe",
        [
          "-NoProfile",
          "-Command",
          `Expand-Archive -Path '${archivePath.replace(/'/g, "''")}' -DestinationPath '${destDir.replace(/'/g, "''")}' -Force`,
        ],
        { stdio: "pipe" },
      );
    } else {
      execFileSync("unzip", ["-q", archivePath, "-d", destDir], { stdio: "pipe" });
    }
  } else {
    execFileSync("tar", ["-xzf", archivePath, "-C", destDir], { stdio: "pipe" });
  }

  const direct = ["playon", "playon-node"].map((n) => path.join(destDir, n));
  for (const d of direct) {
    if (fs.existsSync(path.join(d, "package.json"))) return d;
  }
  const kids = fs.readdirSync(destDir, { withFileTypes: true }).filter((e) => e.isDirectory());
  for (const k of kids) {
    const p = path.join(destDir, k.name);
    if (fs.existsSync(path.join(p, "package.json"))) return p;
  }
  throw new Error("update_extract_root_missing");
}

function detectInstallMode(homeRoot: string): "portable" | "service" {
  if (process.env.PLAYON_SERVICE === "1") return "service";
  if (process.platform !== "win32") {
    try {
      execFileSync("systemctl", ["is-enabled", "playon.service"], { stdio: "pipe" });
      return "service";
    } catch {
      // portable
    }
  } else {
    try {
      execFileSync(
        "powershell.exe",
        [
          "-NoProfile",
          "-Command",
          "Get-ScheduledTask -TaskName PlayOnControlPlane -ErrorAction Stop | Out-Null",
        ],
        { stdio: "pipe" },
      );
      return "service";
    } catch {
      // portable
    }
  }
  if (fs.existsSync(path.join(homeRoot, "Start-PlayOn.ps1")) || fs.existsSync(path.join(homeRoot, "start-playon.sh"))) {
    return "portable";
  }
  return "portable";
}

function resolveHomeRoot(): string {
  if (process.env.PLAYON_HOME?.trim()) return path.resolve(process.env.PLAYON_HOME.trim());
  return findRepoRoot(process.cwd());
}

function resolveApplyScript(homeRoot: string): string {
  const candidates = [
    path.join(homeRoot, "deploy", "portable", "apply-update.mjs"),
    path.join(findRepoRoot(process.cwd()), "deploy", "portable", "apply-update.mjs"),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  throw new Error("apply_update_script_missing");
}

function bundledNodeBin(homeRoot: string): string | null {
  const win = path.join(homeRoot, "runtime", "node", "node.exe");
  const nix = path.join(homeRoot, "runtime", "node", "bin", "node");
  if (fs.existsSync(win)) return win;
  if (fs.existsSync(nix)) return nix;
  return null;
}

export class UpdateService {
  constructor(
    private readonly db: Db,
    private readonly config: AppConfig,
    private readonly eventHub: EventHub,
  ) {}

  private publishProgress(
    target: "home" | "node",
    phase: UpdateProgressPhase,
    message: string,
    nodeId?: string,
    percent?: number,
  ) {
    if (target === "home") setHomeApplyState(phase, message);
    this.eventHub.publish({
      type: "update.progress",
      target,
      nodeId,
      phase,
      message,
      percent,
    });
  }

  manifestUrl(): string {
    return resolveUpdateManifestUrl(process.env.PLAYON_UPDATE_MANIFEST_URL);
  }

  async getStatus(opts?: { force?: boolean }): Promise<UpdatesStatus> {
    const currentVersion = readAppVersion();
    const platform = currentUpdatePlatform();
    let latestVersion: string | null = null;
    let channel: string | null = null;
    let notesUrl: string | null = null;
    let manifestError: string | null = null;
    let manifest: UpdateManifest | null = null;
    let checkedAt: string | null = cache ? new Date(cache.fetchedAt).toISOString() : null;

    try {
      manifest = await fetchUpdateManifest(this.manifestUrl(), opts);
      latestVersion = manifest.version;
      channel = manifest.channel;
      notesUrl = manifest.notesUrl ?? null;
      checkedAt = new Date(cache!.fetchedAt).toISOString();
    } catch (err) {
      manifestError = err instanceof Error ? err.message : "update_manifest_error";
    }

    const homeUpdateAvailable = Boolean(
      latestVersion && isNewerVersion(latestVersion, currentVersion),
    );
    const homeCurrentEnoughForNodes = Boolean(
      latestVersion && !isNewerVersion(latestVersion, currentVersion),
    );

    const list = await this.db.select().from(nodes);
    const now = Date.now();
    const nodeStatuses: NodeUpdateStatus[] = list
      .filter((n) => n.id !== LOCAL_NODE_ID)
      .map((n) => {
        const agentVersion = n.agentVersion || "0.0.0";
        const updateAvailable = Boolean(
          latestVersion && isNewerVersion(latestVersion, agentVersion),
        );
        return {
          nodeId: n.id,
          name: n.name,
          os: (n.os as "linux" | "windows") || "linux",
          agentVersion,
          status: deriveNodePresence(n.lastSeenAt, now),
          updateAvailable,
          kind: n.kind || "lan",
        };
      });

    return {
      currentVersion,
      latestVersion,
      channel,
      notesUrl,
      homeUpdateAvailable,
      checkedAt,
      manifestError,
      platform,
      applying: applyState.applying,
      applyPhase: applyState.phase,
      applyMessage: applyState.message,
      homeCurrentEnoughForNodes,
      nodes: nodeStatuses,
    };
  }

  async applyHomeUpdate(): Promise<{ ok: true; version: string; restarting: true }> {
    if (applyState.applying) throw new Error("update_already_in_progress");
    this.publishProgress("home", "checking", "Checking for updates…", undefined, 0);

    try {
      const manifest = await fetchUpdateManifest(this.manifestUrl(), { force: true });
      const currentVersion = readAppVersion();
      if (!isNewerVersion(manifest.version, currentVersion)) {
        throw new Error("update_already_current");
      }
      const platform = currentUpdatePlatform();
      const asset = pickAsset(manifest, "home", platform);
      const homeRoot = resolveHomeRoot();
      const stagingRoot = path.join(this.config.dataRoot, ".updates", "home");
      fs.rmSync(stagingRoot, { recursive: true, force: true });
      fs.mkdirSync(stagingRoot, { recursive: true });
      const archiveName = path.basename(new URL(asset.downloadUrl).pathname);
      const archivePath = path.join(stagingRoot, archiveName);

      await downloadAndVerifyUpdate({
        downloadUrl: asset.downloadUrl,
        sha256: asset.sha256,
        destFile: archivePath,
        onProgress: (phase, message, percent) =>
          this.publishProgress("home", phase, message, undefined, percent),
      });

      this.publishProgress("home", "applying", "Extracting update…", undefined, 80);
      const extractDir = path.join(stagingRoot, "extracted");
      const sourceRoot = extractUpdateArchive(archivePath, extractDir);

      const mode = detectInstallMode(homeRoot);
      const applySrc = resolveApplyScript(homeRoot);
      const runnerDir = fs.mkdtempSync(path.join(os.tmpdir(), "playon-apply-"));
      const applyDest = path.join(runnerDir, "apply-update.mjs");
      fs.copyFileSync(applySrc, applyDest);

      const nodeBin = bundledNodeBin(homeRoot) || process.execPath;
      const args = [
        applyDest,
        "--target",
        homeRoot,
        "--source",
        sourceRoot,
        "--preserve",
        "data,env",
        "--mode",
        mode,
        "--kind",
        "home",
      ];

      this.publishProgress("home", "restarting", "Restarting PlayOn…", undefined, 95);
      const child = spawn(nodeBin, args, {
        detached: true,
        stdio: "ignore",
        cwd: runnerDir,
        env: { ...process.env },
      });
      child.unref();

      // Give the apply helper a moment to start, then exit so files can be replaced.
      setTimeout(() => {
        process.exit(0);
      }, 500);

      return { ok: true, version: manifest.version, restarting: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : "update_failed";
      this.publishProgress("home", "failed", message);
      throw err;
    }
  }

  async enqueueNodeUpdate(nodeId: string): Promise<{ jobId: string; version: string }> {
    if (nodeId === LOCAL_NODE_ID) throw new Error("local_node_updates_with_home");
    const status = await this.getStatus({ force: true });
    if (!status.homeCurrentEnoughForNodes) {
      throw new Error("update_home_first");
    }
    if (!status.latestVersion) throw new Error("update_manifest_unavailable");

    const row = (await this.db.select().from(nodes)).find((n) => n.id === nodeId);
    if (!row) throw new Error("node_not_found");
    if (deriveNodePresence(row.lastSeenAt, Date.now()) === "offline") {
      throw new Error("node_offline");
    }
    if (!isNewerVersion(status.latestVersion, row.agentVersion || "0.0.0")) {
      throw new Error("node_already_current");
    }

    const manifest = await fetchUpdateManifest(this.manifestUrl());
    const platform = platformForNodeOs(row.os);
    const asset = pickAsset(manifest, "node", platform);

    const job = nodeJobService.enqueue(nodeId, "node_self_update", {
      downloadUrl: asset.downloadUrl,
      sha256: asset.sha256,
      version: manifest.version,
      preserve: ["data", "env", "node.env", "node.env.cmd"],
    });

    this.publishProgress(
      "node",
      "downloading",
      `Queued update to ${manifest.version} for ${row.name}`,
      nodeId,
      0,
    );
    return { jobId: job.id, version: manifest.version };
  }
}
