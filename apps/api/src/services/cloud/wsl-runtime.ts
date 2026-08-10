/**
 * Enable Linux runtime via WSL2 on Windows Home.
 * Windows-only: status/enable/repair for the local-wsl node.
 */
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { eq } from "drizzle-orm";
import { LOCAL_WSL_NODE_ID, WSL_DISTRO_NAME } from "@playon/shared";
import { findRepoRoot, type AppConfig } from "../../config.js";
import type { Db } from "../../db/client.js";
import { nodes } from "../../db/schema.js";

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
  | "wsl_spawn_failed";

export type WslStatusResult = {
  status: WslRuntimeStatus;
  message: string;
  distro: string;
  nodeId: string;
  error?: WslRuntimeError;
  /** True when the local-wsl node record exists and heartbeat is recent. */
  nodeOnline?: boolean;
};

export type WslEnableResult = {
  ok: boolean;
  status: WslRuntimeStatus;
  message: string;
  nodeId: string;
  error?: WslRuntimeError;
};

/** Resolve ensure-wsl-runtime.ps1 from common Home / monorepo layouts. */
export function resolveEnsureWslScriptPath(cwd: string = process.cwd()): string | null {
  const repoRoot = findRepoRoot(cwd);
  const candidates = [
    path.join(cwd, "deploy/windows/ensure-wsl-runtime.ps1"),
    path.join(repoRoot, "deploy/windows/ensure-wsl-runtime.ps1"),
    path.join(cwd, "../../deploy/windows/ensure-wsl-runtime.ps1"),
    path.resolve(
      path.dirname(new URL(import.meta.url).pathname),
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

export class WslRuntimeService {
  constructor(
    private readonly db: Db,
    private readonly config: AppConfig,
  ) {}

  /** Check if we're on Windows — WSL is only available there. */
  isAvailable(): boolean {
    return isWindows();
  }

  /** Get the current status of the WSL Linux runtime. */
  async status(): Promise<WslStatusResult> {
    if (!isWindows()) {
      return {
        status: "error",
        message: "WSL is only available on Windows",
        distro: WSL_DISTRO_NAME,
        nodeId: LOCAL_WSL_NODE_ID,
        error: "wsl_not_windows",
      };
    }

    const scriptPath = resolveEnsureWslScriptPath();
    if (!scriptPath) {
      return {
        status: "error",
        message: "ensure-wsl-runtime.ps1 not found",
        distro: WSL_DISTRO_NAME,
        nodeId: LOCAL_WSL_NODE_ID,
        error: "wsl_script_missing",
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
          nodeId: LOCAL_WSL_NODE_ID,
          error: "wsl_spawn_failed",
        });
      }, 15_000);

      ps.stdout.on("data", (data: Buffer) => {
        stdout += data.toString("utf8");
      });
      ps.stderr.on("data", (data: Buffer) => {
        stderr += data.toString("utf8");
      });

      ps.on("close", async () => {
        const parsed = parseWslScriptOutput(stdout || stderr);
        const error = codeToError(parsed.code);
        const nodeOnline = await this.isNodeOnline();

        finish({
          status: parsed.status,
          message: parsed.message,
          distro: WSL_DISTRO_NAME,
          nodeId: LOCAL_WSL_NODE_ID,
          error,
          nodeOnline,
        });
      });

      ps.on("error", (err) => {
        finish({
          status: "error",
          message: err.message,
          distro: WSL_DISTRO_NAME,
          nodeId: LOCAL_WSL_NODE_ID,
          error: "wsl_spawn_failed",
        });
      });
    });
  }

  /**
   * Enable the WSL Linux runtime.
   * This spawns an elevated PowerShell process.
   * Returns immediately after spawning; the script handles its own progress.
   */
  async enable(): Promise<WslEnableResult> {
    if (!isWindows()) {
      return {
        ok: false,
        status: "error",
        message: "WSL is only available on Windows",
        nodeId: LOCAL_WSL_NODE_ID,
        error: "wsl_not_windows",
      };
    }

    const scriptPath = resolveEnsureWslScriptPath();
    if (!scriptPath) {
      return {
        ok: false,
        status: "error",
        message: "ensure-wsl-runtime.ps1 not found",
        nodeId: LOCAL_WSL_NODE_ID,
        error: "wsl_script_missing",
      };
    }

    // Upsert a pending placeholder node
    await this.upsertPlaceholder();

    // Build arguments for the script
    const args = ["-ExecutionPolicy", "Bypass", "-File", scriptPath];
    if (this.config.advertiseHost && this.config.port) {
      args.push("-ApiUrl", `http://${this.config.advertiseHost}:${this.config.port}`);
    }
    if (this.config.nodeToken) {
      args.push("-NodeToken", this.config.nodeToken);
    }

    return new Promise((resolve) => {
      // Spawn elevated PowerShell using Start-Process -Verb RunAs
      const elevatedScript = `
        Start-Process powershell.exe -Verb RunAs -Wait -ArgumentList @(
          '-ExecutionPolicy', 'Bypass',
          '-File', '${scriptPath.replace(/'/g, "''")}',
          '-ApiUrl', 'http://${this.config.advertiseHost}:${this.config.port}',
          '-NodeToken', '${this.config.nodeToken ?? ""}'
        )
      `;

      const ps = spawn("powershell.exe", [
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        elevatedScript,
      ], {
        windowsHide: false,
      });

      let stdout = "";
      let stderr = "";

      ps.stdout.on("data", (data: Buffer) => {
        stdout += data.toString("utf8");
      });
      ps.stderr.on("data", (data: Buffer) => {
        stderr += data.toString("utf8");
      });

      ps.on("close", async () => {
        // After spawn completes, check actual status
        const status = await this.status();
        resolve({
          ok: status.status === "ready",
          status: status.status,
          message: status.message,
          nodeId: LOCAL_WSL_NODE_ID,
          error: status.error,
        });
      });

      ps.on("error", (err) => {
        resolve({
          ok: false,
          status: "error",
          message: err.message,
          nodeId: LOCAL_WSL_NODE_ID,
          error: "wsl_spawn_failed",
        });
      });
    });
  }

  /**
   * Repair the WSL Linux runtime — re-runs the setup with -Repair flag.
   */
  async repair(): Promise<WslEnableResult> {
    if (!isWindows()) {
      return {
        ok: false,
        status: "error",
        message: "WSL is only available on Windows",
        nodeId: LOCAL_WSL_NODE_ID,
        error: "wsl_not_windows",
      };
    }

    const scriptPath = resolveEnsureWslScriptPath();
    if (!scriptPath) {
      return {
        ok: false,
        status: "error",
        message: "ensure-wsl-runtime.ps1 not found",
        nodeId: LOCAL_WSL_NODE_ID,
        error: "wsl_script_missing",
      };
    }

    return new Promise((resolve) => {
      const elevatedScript = `
        Start-Process powershell.exe -Verb RunAs -Wait -ArgumentList @(
          '-ExecutionPolicy', 'Bypass',
          '-File', '${scriptPath.replace(/'/g, "''")}',
          '-ApiUrl', 'http://${this.config.advertiseHost}:${this.config.port}',
          '-NodeToken', '${this.config.nodeToken ?? ""}',
          '-Repair'
        )
      `;

      const ps = spawn("powershell.exe", [
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        elevatedScript,
      ], {
        windowsHide: false,
      });

      let stdout = "";
      let stderr = "";

      ps.stdout.on("data", (data: Buffer) => {
        stdout += data.toString("utf8");
      });
      ps.stderr.on("data", (data: Buffer) => {
        stderr += data.toString("utf8");
      });

      ps.on("close", async () => {
        const status = await this.status();
        resolve({
          ok: status.status === "ready",
          status: status.status,
          message: status.message,
          nodeId: LOCAL_WSL_NODE_ID,
          error: status.error,
        });
      });

      ps.on("error", (err) => {
        resolve({
          ok: false,
          status: "error",
          message: err.message,
          nodeId: LOCAL_WSL_NODE_ID,
          error: "wsl_spawn_failed",
        });
      });
    });
  }

  /** Upsert a pending placeholder node for local-wsl. */
  private async upsertPlaceholder(): Promise<void> {
    const existing = await this.db
      .select()
      .from(nodes)
      .where(eq(nodes.id, LOCAL_WSL_NODE_ID))
      .limit(1);

    if (existing[0]) {
      return;
    }

    await this.db.insert(nodes).values({
      id: LOCAL_WSL_NODE_ID,
      name: "Linux (WSL)",
      os: "linux",
      docker: false,
      native: true,
      steamcmd: false,
      freeDiskBytes: null,
      agentVersion: "pending",
      lastSeenAt: new Date(0),
      kind: "local",
      tunnelStatus: "none",
    });
  }

  /** Check if the local-wsl node is online (heartbeat recent). */
  private async isNodeOnline(): Promise<boolean> {
    const row = await this.db
      .select()
      .from(nodes)
      .where(eq(nodes.id, LOCAL_WSL_NODE_ID))
      .limit(1);

    if (!row[0]) return false;
    if (row[0].agentVersion === "pending") return false;

    const age = Date.now() - row[0].lastSeenAt.getTime();
    return age < 60_000;
  }
}

/** Test helper */
export function clearWslStateForTests(): void {
  // No in-memory state to clear for this service
}
