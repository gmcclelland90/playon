/**
 * Execute ensure-wsl-runtime.ps1 on this Windows host (node job wsl_ensure).
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseNodeJobArgs, parseNodeJobResult, type WslEnsureResult } from "@playon/shared";

export type WslEnsureProgressFn = (message: string) => void | Promise<void>;

function parseScriptJson(output: string): { status: string; message: string; code: number } {
  try {
    const lines = output.trim().split(/\r?\n/);
    for (const line of lines.reverse()) {
      if (line.startsWith("{") && line.includes('"status"')) {
        const parsed = JSON.parse(line) as { status: string; message: string; code: number };
        return {
          status: String(parsed.status ?? "error"),
          message: String(parsed.message ?? ""),
          code: Number(parsed.code ?? 1),
        };
      }
    }
  } catch {
    /* fall through */
  }
  return { status: "error", message: output.slice(0, 400) || "wsl_ensure_no_output", code: 1 };
}

function finishEnsure(
  r: { status: string; message: string; code: number },
  wslNodeId: string,
  needsElevation: boolean,
): WslEnsureResult {
  return parseNodeJobResult("wsl_ensure", {
    status: r.status,
    message: r.message,
    code: r.code,
    wslNodeId,
    needsElevation: needsElevation || undefined,
  });
}

function emitPhaseLine(line: string, onProgress?: WslEnsureProgressFn): void {
  const trimmed = line.trim();
  if (!trimmed) return;
  if (trimmed.startsWith("PLAYON_WSL_PHASE:")) {
    void onProgress?.(trimmed.slice("PLAYON_WSL_PHASE:".length).trim());
    return;
  }
  if (trimmed.startsWith("==>")) {
    void onProgress?.(trimmed.replace(/^==>\s*/, "").trim());
  }
}

function runPowershell(
  args: string[],
  timeoutMs: number,
  onProgress?: WslEnsureProgressFn,
): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    const ps = spawn("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", ...args], {
      windowsHide: true,
    });
    let out = "";
    let lineBuf = "";
    let settled = false;
    const finish = (code: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (lineBuf.trim()) emitPhaseLine(lineBuf, onProgress);
      resolve({ code, out });
    };
    const timer = setTimeout(() => {
      ps.kill();
      finish(1);
    }, timeoutMs);
    const onChunk = (d: Buffer) => {
      const text = d.toString("utf8");
      out += text;
      lineBuf += text;
      const parts = lineBuf.split(/\r?\n/);
      lineBuf = parts.pop() ?? "";
      for (const line of parts) emitPhaseLine(line, onProgress);
    };
    ps.stdout.on("data", onChunk);
    ps.stderr.on("data", onChunk);
    ps.on("close", (code) => finish(code ?? 1));
    ps.on("error", (err) => {
      out += err.message;
      finish(1);
    });
  });
}

/**
 * Run the ensure script. Prefer already-elevated agent; fall back to UAC for legacy installs.
 */
export async function executeWslEnsureJob(
  args: unknown,
  onProgress?: WslEnsureProgressFn,
): Promise<WslEnsureResult> {
  const parsed = parseNodeJobArgs("wsl_ensure", args);
  if (process.platform !== "win32") {
    return parseNodeJobResult("wsl_ensure", {
      status: "error",
      message: "wsl_ensure_not_windows",
      code: 1,
      wslNodeId: parsed.wslNodeId,
      needsElevation: false,
    });
  }

  const scriptPath = path.join(os.tmpdir(), `playon-ensure-wsl-${Date.now()}.ps1`);
  fs.writeFileSync(scriptPath, Buffer.from(parsed.scriptBase64, "base64"));

  const baseArgs = [
    "-File",
    scriptPath,
    "-ApiUrl",
    parsed.apiUrl,
    "-NodeToken",
    parsed.nodeToken,
    "-NodeId",
    parsed.wslNodeId,
  ];
  if (parsed.action === "status") {
    baseArgs.push("-StatusOnly");
  } else if (parsed.action === "repair") {
    baseArgs.push("-Repair");
  }

  const timeoutMs = parsed.action === "status" ? 60_000 : 15 * 60_000;

  try {
    if (parsed.action === "status") {
      const { out } = await runPowershell(baseArgs, timeoutMs);
      const r = parseScriptJson(out);
      return parseNodeJobResult("wsl_ensure", {
        status: r.status,
        message: r.message,
        code: r.code,
        wslNodeId: parsed.wslNodeId,
      });
    }

    await onProgress?.("Starting WSL setup on this Windows host…");

    // Preferred path: agent already elevated (SYSTEM / Highest from install-node).
    const direct = await runPowershell(baseArgs, timeoutMs, onProgress);
    const dr = parseScriptJson(direct.out);
    const privilegeDenied =
      dr.code === 12 || /Administrator privileges required/i.test(dr.message + direct.out);
    if (!privilegeDenied) {
      return finishEnsure(dr, parsed.wslNodeId, false);
    }

    await onProgress?.("Requesting elevation (UAC)…");

    // Legacy non-elevated agents: try interactive UAC once.
    const esc = (s: string) => s.replace(/'/g, "''");
    const elevateCmd = `
try {
  $p = Start-Process -FilePath powershell.exe -Verb RunAs -Wait -PassThru -ArgumentList @(
    '-NoProfile','-ExecutionPolicy','Bypass',
    '-File','${esc(scriptPath)}',
    '-ApiUrl','${esc(parsed.apiUrl)}',
    '-NodeToken','${esc(parsed.nodeToken)}',
    '-NodeId','${esc(parsed.wslNodeId)}'${parsed.action === "repair" ? ",'-Repair'" : ""}
  )
  if (-not $p) { exit 12 }
  if ($null -eq $p.ExitCode) { exit 12 }
  exit [int]$p.ExitCode
} catch {
  Write-Output ($_ | Out-String)
  exit 12
}
`;
    const elevated = await runPowershell(["-Command", elevateCmd], timeoutMs, onProgress);
    const elevatedParsed = parseScriptJson(elevated.out);

    if (elevated.code === 0 && elevated.out.includes('"status"')) {
      return finishEnsure(elevatedParsed, parsed.wslNodeId, false);
    }

    if (elevated.code === 0) {
      const statusRun = await runPowershell(
        ["-File", scriptPath, "-StatusOnly", "-NodeId", parsed.wslNodeId],
        60_000,
      );
      const sr = parseScriptJson(statusRun.out);
      if (sr.status === "ready" || sr.status === "reboot_required") {
        return finishEnsure(sr, parsed.wslNodeId, false);
      }
      return finishEnsure(
        {
          status: sr.status || "not_installed",
          message:
            sr.message ||
            "WSL setup needs an elevated Windows node agent (re-run elevate-node-agent.ps1) or an interactive UAC prompt",
          code: 12,
        },
        parsed.wslNodeId,
        true,
      );
    }

    const needsElevation =
      elevated.code === 12 ||
      dr.code === 12 ||
      /cancelled|elevation|RunAs|724|Access is denied|Administrator privileges/i.test(
        elevated.out + direct.out + dr.message,
      );

    return finishEnsure(
      {
        status: dr.status || "error",
        message:
          dr.message ||
          elevated.out.slice(0, 400) ||
          "WSL setup needs an elevated Windows node agent - run deploy/windows/elevate-node-agent.ps1 as Administrator",
        code: dr.code || elevated.code || 1,
      },
      parsed.wslNodeId,
      needsElevation,
    );
  } finally {
    try {
      fs.unlinkSync(scriptPath);
    } catch {
      /* ignore */
    }
  }
}
