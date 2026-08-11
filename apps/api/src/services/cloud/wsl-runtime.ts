/**
 * Enable Linux runtime via WSL2 on a Windows node (Home may be any OS).
 * Prefer node job on the Windows agent; local UAC on Windows Home; one-liner last resort.
 */
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import {
  LOCAL_NODE_ID,
  NodeJobError,
  WSL_DISTRO_NAME,
  isWslNodeId,
  wslSiblingNodeId,
  type NodeKind,
  type WslEnsureResult,
} from "@playon/shared";
import { findRepoRoot, type AppConfig } from "../../config.js";
import type { Db } from "../../db/client.js";
import { nodes } from "../../db/schema.js";
import { nodeJobService } from "../node-jobs.js";

export type WslRuntimeStatus =
  | "not_installed"
  | "reboot_required"
  | "distro_missing"
  | "docker_missing"
  | "agent_missing"
  | "ready"
  | "error";

export type WslRuntimeError =
  | "wsl_reboot_required"
  | "wsl_virt_disabled"
  | "wsl_user_cancelled_uac"
  | "wsl_distro_failed"
  | "wsl_docker_failed"
  | "wsl_agent_failed"
  | "wsl_not_windows"
  | "wsl_script_missing"
  | "wsl_spawn_failed"
  | "wsl_unknown_node"
  | "wsl_token_invalid";

export type WslStatusResult = {
  status: WslRuntimeStatus;
  message: string;
  distro: string;
  /** WSL sibling node id (local-wsl or {nodeId}-wsl). */
  nodeId: string;
  /** Windows node this runtime is attached to. */
  windowsNodeId: string;
  error?: WslRuntimeError;
  /** True when the WSL sibling node record exists and heartbeat is recent. */
  nodeOnline?: boolean;
  /** True when this API process can run ensure-wsl-runtime.ps1 locally (Windows + local node). */
  canRunLocally?: boolean;
};

export type WslEnableResult = {
  ok: boolean;
  status: WslRuntimeStatus;
  message: string;
  nodeId: string;
  windowsNodeId: string;
  error?: WslRuntimeError;
  /** Elevated PowerShell one-liner when enable must run on a remote Windows host. */
  oneLiner?: string;
  mode?: "local_uac" | "node_job" | "token";
};

export type WslTokenRecord = {
  token: string;
  windowsNodeId: string;
  repair: boolean;
  expiresAt: number;
};

const wslTokens = new Map<string, WslTokenRecord>();

/** Resolve ensure-wsl-runtime.ps1 from common Home / monorepo layouts. */
export function resolveEnsureWslScriptPath(cwd: string = process.cwd()): string | null {
  const repoRoot = findRepoRoot(cwd);
  const candidates = [
    path.join(cwd, "deploy/windows/ensure-wsl-runtime.ps1"),
    path.join(repoRoot, "deploy/windows/ensure-wsl-runtime.ps1"),
    path.join(cwd, "../../deploy/windows/ensure-wsl-runtime.ps1"),
    path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "../../../../../deploy/windows/ensure-wsl-runtime.ps1",
    ),
  ];
  for (const p of candidates) {
    try {
      const normalized = p.replace(/^\/([A-Za-z]):/, "$1:");
      if (fs.existsSync(normalized)) return normalized;
    } catch {
      /* ignore */
    }
  }
  return null;
}

function isWindows(): boolean {
  return process.platform === "win32";
}

function parseWslScriptOutput(output: string): { status: WslRuntimeStatus; message: string; code: number } {
  try {
    const lines = output.trim().split("\n");
    for (const line of lines.reverse()) {
      if (line.startsWith("{") && line.includes('"status"')) {
        const parsed = JSON.parse(line) as {
          status: string;
          message: string;
          code: number;
        };
        return {
          status: parsed.status as WslRuntimeStatus,
          message: parsed.message,
          code: parsed.code,
        };
      }
    }
  } catch {
    /* fall through */
  }
  return {
    status: "error",
    message: output.slice(0, 200),
    code: 1,
  };
}

function codeToError(code: number): WslRuntimeError | undefined {
  switch (code) {
    case 10:
      return "wsl_reboot_required";
    case 11:
      return "wsl_virt_disabled";
    case 12:
      return "wsl_user_cancelled_uac";
    case 13:
      return "wsl_distro_failed";
    case 14:
      return "wsl_docker_failed";
    case 15:
      return "wsl_agent_failed";
    default:
      return undefined;
  }
}

function escapePsSingle(s: string): string {
  return s.replace(/'/g, "''");
}

export class WslRuntimeService {
  constructor(
    private readonly db: Db,
    private readonly config: AppConfig,
  ) {}

  /**
   * True when this API host can run the ensure script locally for `local`.
   * Remote Windows nodes use the token one-liner instead.
   */
  isAvailable(): boolean {
    return isWindows();
  }

  /** Resolve Windows node row or throw. */
  private async requireWindowsNode(windowsNodeId: string): Promise<{
    id: string;
    os: string;
    kind: NodeKind | string;
    name: string;
  }> {
    const id = windowsNodeId.trim() || LOCAL_NODE_ID;
    if (isWslNodeId(id)) {
      throw new Error(`wsl_not_windows: ${id} is a WSL sibling; pass the Windows node id`);
    }
    const rows = await this.db.select().from(nodes).where(eq(nodes.id, id)).limit(1);
    const row = rows[0];
    if (!row) throw new Error(`wsl_unknown_node: ${id}`);
    if (row.os !== "windows") {
      throw new Error(`wsl_not_windows: node ${id} os=${row.os}`);
    }
    return { id: row.id, os: row.os, kind: row.kind, name: row.name };
  }

  private canRunLocallyFor(windowsNodeId: string): boolean {
    return isWindows() && windowsNodeId === LOCAL_NODE_ID;
  }

  private apiBase(): string {
    return `http://${this.config.advertiseHost}:${this.config.port}`;
  }

  /** Get WSL status for a Windows node (defaults to `local`). */
  async status(windowsNodeId: string = LOCAL_NODE_ID): Promise<WslStatusResult> {
    const win = await this.requireWindowsNode(windowsNodeId);
    const wslId = wslSiblingNodeId(win.id);
    const canRunLocally = this.canRunLocallyFor(win.id);
    const nodeOnline = await this.isNodeOnline(wslId);

    if (canRunLocally) {
      return this.statusLocal(win.id, wslId, nodeOnline);
    }

    // Remote / Linux Home: infer from sibling heartbeat only.
    if (nodeOnline) {
      return {
        status: "ready",
        message: "WSL Linux runtime node is online",
        distro: WSL_DISTRO_NAME,
        nodeId: wslId,
        windowsNodeId: win.id,
        nodeOnline: true,
        canRunLocally: false,
      };
    }

    const pending = await this.db.select().from(nodes).where(eq(nodes.id, wslId)).limit(1);
    if (pending[0]?.agentVersion === "pending") {
      return {
        status: "agent_missing",
        message:
          "WSL sibling placeholder exists — run the elevated one-liner on the Windows host, then wait for heartbeat",
        distro: WSL_DISTRO_NAME,
        nodeId: wslId,
        windowsNodeId: win.id,
        nodeOnline: false,
        canRunLocally: false,
      };
    }

    return {
      status: "not_installed",
      message:
        "Enable Linux runtime on this Windows node (elevated PowerShell one-liner), then wait for the WSL sibling to heartbeat",
      distro: WSL_DISTRO_NAME,
      nodeId: wslId,
      windowsNodeId: win.id,
      nodeOnline: false,
      canRunLocally: false,
    };
  }

  private async statusLocal(
    windowsNodeId: string,
    wslId: string,
    nodeOnline: boolean,
  ): Promise<WslStatusResult> {
    const scriptPath = resolveEnsureWslScriptPath();
    if (!scriptPath) {
      return {
        status: "error",
        message: "ensure-wsl-runtime.ps1 not found",
        distro: WSL_DISTRO_NAME,
        nodeId: wslId,
        windowsNodeId,
        error: "wsl_script_missing",
        canRunLocally: true,
      };
    }

    return new Promise((resolve) => {
      const ps = spawn("powershell.exe", [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        scriptPath,
        "-StatusOnly",
        "-NodeId",
        wslId,
      ]);

      let stdout = "";
      let stderr = "";
      let settled = false;
      const finish = (result: WslStatusResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(result);
      };
      const timer = setTimeout(() => {
        ps.kill();
        finish({
          status: "error",
          message: "WSL status probe timed out",
          distro: WSL_DISTRO_NAME,
          nodeId: wslId,
          windowsNodeId,
          error: "wsl_spawn_failed",
          canRunLocally: true,
        });
      }, 15_000);

      ps.stdout.on("data", (data: Buffer) => {
        stdout += data.toString("utf8");
      });
      ps.stderr.on("data", (data: Buffer) => {
        stderr += data.toString("utf8");
      });

      ps.on("close", () => {
        const parsed = parseWslScriptOutput(stdout || stderr);
        const error = codeToError(parsed.code);
        finish({
          status: parsed.status,
          message: parsed.message,
          distro: WSL_DISTRO_NAME,
          nodeId: wslId,
          windowsNodeId,
          error,
          nodeOnline,
          canRunLocally: true,
        });
      });

      ps.on("error", (err) => {
        finish({
          status: "error",
          message: err.message,
          distro: WSL_DISTRO_NAME,
          nodeId: wslId,
          windowsNodeId,
          error: "wsl_spawn_failed",
          canRunLocally: true,
        });
      });
    });
  }

  async createToken(
    windowsNodeId: string,
    opts?: { repair?: boolean },
  ): Promise<{
    token: string;
    windowsNodeId: string;
    nodeId: string;
    oneLiner: string;
    expiresAt: string;
    repair: boolean;
  }> {
    const win = await this.requireWindowsNode(windowsNodeId);
    const wslId = wslSiblingNodeId(win.id);
    await this.upsertPlaceholder(win.id, win.kind);
    const token = nanoid(24);
    const expiresAt = Date.now() + 30 * 60 * 1000;
    const repair = Boolean(opts?.repair);
    wslTokens.set(token, { token, windowsNodeId: win.id, repair, expiresAt });
    const base = this.apiBase();
    const url = `${base}/api/nodes/${encodeURIComponent(win.id)}/wsl/${token}`;
    const oneLiner =
      `powershell -NoProfile -ExecutionPolicy Bypass -Command ` +
      `"$p=Join-Path $env:TEMP 'playon-wsl-bootstrap.ps1'; ` +
      `Invoke-RestMethod -Uri '${url.replace(/'/g, "''")}' -OutFile $p; ` +
      `Start-Process powershell.exe -Verb RunAs -Wait -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File',$p)"`;
    return {
      token,
      windowsNodeId: win.id,
      nodeId: wslId,
      oneLiner,
      expiresAt: new Date(expiresAt).toISOString(),
      repair,
    };
  }

  /** Single-use bootstrap PowerShell that embeds ensure-wsl-runtime.ps1 and runs it elevated. */
  async scriptForToken(windowsNodeId: string, token: string): Promise<string> {
    const rec = wslTokens.get(token);
    if (!rec || rec.windowsNodeId !== windowsNodeId || rec.expiresAt < Date.now()) {
      wslTokens.delete(token);
      throw new Error("wsl_token_invalid");
    }
    wslTokens.delete(token);
    const win = await this.requireWindowsNode(windowsNodeId);
    const wslId = wslSiblingNodeId(win.id);
    const scriptPath = resolveEnsureWslScriptPath();
    if (!scriptPath) throw new Error("wsl_script_missing");
    const body = fs.readFileSync(scriptPath, "utf8");
    const b64 = Buffer.from(body, "utf8").toString("base64");
    const apiUrl = this.apiBase();
    const nodeToken = this.config.nodeToken ?? "";
    const repairFlag = rec.repair ? "\n  '-Repair'" : "";
    return `# PlayOn WSL bootstrap (single-use token)
$ErrorActionPreference = "Stop"
$dest = Join-Path $env:TEMP "ensure-wsl-runtime.ps1"
$bytes = [Convert]::FromBase64String('${b64}')
[System.IO.File]::WriteAllBytes($dest, $bytes)
$argList = @(
  '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $dest,
  '-ApiUrl', '${escapePsSingle(apiUrl)}',
  '-NodeToken', '${escapePsSingle(nodeToken)}',
  '-NodeId', '${escapePsSingle(wslId)}'${repairFlag}
)
& powershell.exe @argList
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
`;
  }

  /**
   * Enable WSL for a Windows node.
   * Prefer: local UAC (Windows Home + local) → node job on online Windows agent →
   * elevated one-liner only when the agent cannot run/elevate.
   */
  async enable(windowsNodeId: string = LOCAL_NODE_ID): Promise<WslEnableResult> {
    const win = await this.requireWindowsNode(windowsNodeId);
    const wslId = wslSiblingNodeId(win.id);
    await this.upsertPlaceholder(win.id, win.kind);

    if (this.canRunLocallyFor(win.id)) {
      return this.spawnElevated(win.id, wslId, false);
    }

    const viaJob = await this.runViaNodeJob(win.id, wslId, "enable");
    if (viaJob) return viaJob;

    const tok = await this.createToken(win.id, { repair: false });
    return {
      ok: true,
      status: "not_installed",
      message:
        "Could not run setup via the node agent automatically — run this elevated PowerShell on the Windows host, then wait for the WSL heartbeat",
      nodeId: wslId,
      windowsNodeId: win.id,
      oneLiner: tok.oneLiner,
      mode: "token",
    };
  }

  async repair(windowsNodeId: string = LOCAL_NODE_ID): Promise<WslEnableResult> {
    const win = await this.requireWindowsNode(windowsNodeId);
    const wslId = wslSiblingNodeId(win.id);
    await this.upsertPlaceholder(win.id, win.kind);

    if (this.canRunLocallyFor(win.id)) {
      return this.spawnElevated(win.id, wslId, true);
    }

    const viaJob = await this.runViaNodeJob(win.id, wslId, "repair");
    if (viaJob) return viaJob;

    const tok = await this.createToken(win.id, { repair: true });
    return {
      ok: true,
      status: "agent_missing",
      message:
        "Could not repair via the node agent automatically — run this elevated PowerShell on the Windows host",
      nodeId: wslId,
      windowsNodeId: win.id,
      oneLiner: tok.oneLiner,
      mode: "token",
    };
  }

  /** Enqueue wsl_ensure on the Windows node; null means fall back to one-liner. */
  private async runViaNodeJob(
    windowsNodeId: string,
    wslId: string,
    action: "enable" | "repair" | "status",
  ): Promise<WslEnableResult | null> {
    if (!this.config.nodeToken?.trim()) return null;
    // Require an explicit advertisement — pre-protocol / old agents fall back to one-liner.
    const advertised = nodeJobService.advertisedJobKinds(windowsNodeId);
    if (!advertised?.includes("wsl_ensure")) {
      return null;
    }

    const scriptPath = resolveEnsureWslScriptPath();
    if (!scriptPath) return null;
    const scriptBase64 = fs.readFileSync(scriptPath).toString("base64");
    const timeoutMs = action === "status" ? 90_000 : 15 * 60_000;

    let jobId: string;
    try {
      const job = nodeJobService.enqueue(windowsNodeId, "wsl_ensure", {
        action,
        wslNodeId: wslId,
        apiUrl: this.apiBase(),
        nodeToken: this.config.nodeToken,
        scriptBase64,
      });
      jobId = job.id;
    } catch (err) {
      if (err instanceof NodeJobError && err.code === "unsupported_job_kind") {
        return null;
      }
      throw err;
    }

    try {
      const done = await nodeJobService.waitFor(jobId, { timeoutMs, intervalMs: 500 });
      if (done.status === "failed") {
        const errMsg = done.error ?? "wsl_ensure_failed";
        if (/unsupported_job_kind/i.test(errMsg)) return null;
        return {
          ok: false,
          status: "error",
          message: errMsg,
          nodeId: wslId,
          windowsNodeId,
          mode: "node_job",
        };
      }
      const result = done.result as WslEnsureResult;
      if (result.needsElevation) {
        return null; // caller issues one-liner
      }
      const status = (result.status as WslRuntimeStatus) || "error";
      return {
        ok: status === "ready" || status === "reboot_required",
        status,
        message: result.message,
        nodeId: wslId,
        windowsNodeId,
        error: codeToError(result.code),
        mode: "node_job",
      };
    } catch (err) {
      if (err instanceof NodeJobError && err.code === "timeout") {
        return {
          ok: false,
          status: "error",
          message: `WSL ${action} timed out waiting for the Windows node — check the node agent is online`,
          nodeId: wslId,
          windowsNodeId,
          mode: "node_job",
        };
      }
      throw err;
    }
  }

  private spawnElevated(
    windowsNodeId: string,
    wslId: string,
    repair: boolean,
  ): Promise<WslEnableResult> {
    const scriptPath = resolveEnsureWslScriptPath();
    if (!scriptPath) {
      return Promise.resolve({
        ok: false,
        status: "error",
        message: "ensure-wsl-runtime.ps1 not found",
        nodeId: wslId,
        windowsNodeId,
        error: "wsl_script_missing",
        mode: "local_uac",
      });
    }

    const apiUrl = this.apiBase();
    const nodeToken = this.config.nodeToken ?? "";
    const repairArg = repair ? ", '-Repair'" : "";
    const elevatedScript = `
      Start-Process powershell.exe -Verb RunAs -Wait -ArgumentList @(
        '-ExecutionPolicy', 'Bypass',
        '-File', '${escapePsSingle(scriptPath)}',
        '-ApiUrl', '${escapePsSingle(apiUrl)}',
        '-NodeToken', '${escapePsSingle(nodeToken)}',
        '-NodeId', '${escapePsSingle(wslId)}'${repairArg}
      )
    `;

    return new Promise((resolve) => {
      const ps = spawn(
        "powershell.exe",
        ["-ExecutionPolicy", "Bypass", "-Command", elevatedScript],
        { windowsHide: false },
      );

      ps.on("close", async () => {
        const status = await this.status(windowsNodeId);
        resolve({
          ok: status.status === "ready",
          status: status.status,
          message: status.message,
          nodeId: wslId,
          windowsNodeId,
          error: status.error,
          mode: "local_uac",
        });
      });

      ps.on("error", (err) => {
        resolve({
          ok: false,
          status: "error",
          message: err.message,
          nodeId: wslId,
          windowsNodeId,
          error: "wsl_spawn_failed",
          mode: "local_uac",
        });
      });
    });
  }

  private async upsertPlaceholder(
    windowsNodeId: string,
    parentKind: NodeKind | string,
  ): Promise<void> {
    const wslId = wslSiblingNodeId(windowsNodeId);
    const existing = await this.db.select().from(nodes).where(eq(nodes.id, wslId)).limit(1);
    if (existing[0]) return;

    const kind: NodeKind =
      parentKind === "cloud" ? "cloud" : parentKind === "lan" ? "lan" : "local";
    const name =
      windowsNodeId === LOCAL_NODE_ID ? "Linux (WSL)" : `Linux (WSL) · ${windowsNodeId}`;

    await this.db.insert(nodes).values({
      id: wslId,
      name,
      os: "linux",
      docker: false,
      native: true,
      steamcmd: false,
      freeDiskBytes: null,
      agentVersion: "pending",
      lastSeenAt: new Date(0),
      kind,
      tunnelStatus: "none",
    });
  }

  private async isNodeOnline(wslId: string): Promise<boolean> {
    const row = await this.db.select().from(nodes).where(eq(nodes.id, wslId)).limit(1);
    if (!row[0]) return false;
    if (row[0].agentVersion === "pending") return false;
    const age = Date.now() - row[0].lastSeenAt.getTime();
    return age < 60_000;
  }
}

/** Test helper */
export function clearWslStateForTests(): void {
  wslTokens.clear();
}
