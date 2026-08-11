/**
 * Execute ensure-wsl-runtime.ps1 on this Windows host (node job wsl_ensure).
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseNodeJobArgs, parseNodeJobResult, type WslEnsureResult } from "@playon/shared";

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

function runPowershell(args: string[], timeoutMs: number): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    const ps = spawn("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", ...args], {
      windowsHide: true,
    });
    let out = "";
    let settled = false;
    const finish = (code: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, out });
    };
    const timer = setTimeout(() => {
      ps.kill();
      finish(1);
    }, timeoutMs);
    ps.stdout.on("data", (d: Buffer) => {
      out += d.toString("utf8");
    });
    ps.stderr.on("data", (d: Buffer) => {
      out += d.toString("utf8");
    });
    ps.on("close", (code) => finish(code ?? 1));
    ps.on("error", (err) => {
      out += err.message;
      finish(1);
    });
  });
}

/**
 * Run the ensure script. Enable/repair try UAC elevation first; if that fails, retry
 * in-process (already-elevated agents) and surface needsElevation when still blocked.
 */
export async function executeWslEnsureJob(args: unknown): Promise<WslEnsureResult> {
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

    // Elevate via UAC when possible (interactive desktop).
    const esc = (s: string) => s.replace(/'/g, "''");
    const elevateCmd = `
$p = Start-Process -FilePath powershell.exe -Verb RunAs -Wait -PassThru -ArgumentList @(
  '-NoProfile','-ExecutionPolicy','Bypass',
  '-File','${esc(scriptPath)}',
  '-ApiUrl','${esc(parsed.apiUrl)}',
  '-NodeToken','${esc(parsed.nodeToken)}',
  '-NodeId','${esc(parsed.wslNodeId)}'${parsed.action === "repair" ? ",'-Repair'" : ""}
)
if (-not $p) { exit 12 }
exit $p.ExitCode
`;
    const elevated = await runPowershell(["-Command", elevateCmd], timeoutMs);
    if (elevated.code === 0 || elevated.out.includes('"status"')) {
      const r = parseScriptJson(elevated.out);
      // Elevated Start-Process -Wait often swallows child stdout; re-probe status.
      if (!elevated.out.includes('"status"')) {
        const statusRun = await runPowershell(
          ["-File", scriptPath, "-StatusOnly", "-NodeId", parsed.wslNodeId],
          60_000,
        );
        const sr = parseScriptJson(statusRun.out);
        return parseNodeJobResult("wsl_ensure", {
          status: sr.status,
          message: sr.message || r.message,
          code: sr.code,
          wslNodeId: parsed.wslNodeId,
        });
      }
      return parseNodeJobResult("wsl_ensure", {
        status: r.status,
        message: r.message,
        code: r.code,
        wslNodeId: parsed.wslNodeId,
      });
    }

    // Fallback: run without elevation (agent already admin / features already on).
    const direct = await runPowershell(baseArgs, timeoutMs);
    const dr = parseScriptJson(direct.out);
    if (direct.code === 0 || dr.status === "ready" || dr.status === "reboot_required") {
      return parseNodeJobResult("wsl_ensure", {
        status: dr.status,
        message: dr.message,
        code: dr.code,
        wslNodeId: parsed.wslNodeId,
      });
    }

    const needsElevation =
      elevated.code === 12 ||
      /cancelled|elevation|RunAs|724|Access is denied/i.test(elevated.out + direct.out) ||
      dr.code === 12;

    return parseNodeJobResult("wsl_ensure", {
      status: dr.status || "error",
      message: dr.message || elevated.out.slice(0, 400) || "wsl_ensure_failed",
      code: dr.code || elevated.code || 1,
      wslNodeId: parsed.wslNodeId,
      needsElevation,
    });
  } finally {
    try {
      fs.unlinkSync(scriptPath);
    } catch {
      /* ignore */
    }
  }
}
