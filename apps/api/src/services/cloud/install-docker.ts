/**
 * Install Docker Engine on an existing Linux node (SSH or short-lived one-liner).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { LOCAL_NODE_ID } from "@playon/shared";
import { findRepoRoot, type AppConfig } from "../../config.js";
import type { Db } from "../../db/client.js";
import { nodes } from "../../db/schema.js";
import { defaultSshExec, type SshExec } from "./add-node.js";

export type InstallDockerTokenRecord = {
  token: string;
  nodeId: string;
  expiresAt: number;
};

const installDockerTokens = new Map<string, InstallDockerTokenRecord>();

const DOCKER_DESKTOP_URL =
  "https://docs.docker.com/desktop/setup/install/windows-install/";

/** Resolve ensure-docker.sh from common Home / monorepo layouts. */
export function resolveEnsureDockerScriptPath(
  cwd: string = process.cwd(),
): string | null {
  const repoRoot = findRepoRoot(cwd);
  const candidates = [
    path.join(cwd, "deploy/lib/ensure-docker.sh"),
    path.join(repoRoot, "deploy/lib/ensure-docker.sh"),
    path.join(cwd, "../../deploy/lib/ensure-docker.sh"),
    path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "../../../../../deploy/lib/ensure-docker.sh",
    ),
  ];
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) return p;
    } catch {
      /* ignore */
    }
  }
  return null;
}

/** Self-contained bash that runs ensure-docker main (install + runtime flip + restart). */
export function buildInstallDockerScript(opts?: { scriptBody?: string }): string {
  const fromDisk = opts?.scriptBody ?? readEnsureDockerBody();
  // Force execution path: strip the sourced-guard and call main explicitly.
  const body = fromDisk
    .replace(/\nif \(return 0 2>\/dev\/null\); then[\s\S]*$/m, "\n")
    .trimEnd();
  return `#!/usr/bin/env bash
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
export PLAYON_USER="\${PLAYON_USER:-playon}"
if ! command -v curl >/dev/null 2>&1; then
  if command -v apt-get >/dev/null 2>&1; then apt-get update -y && apt-get install -y curl; fi
fi
${body}
playon_ensure_docker_main
echo "playon_install_docker_ok"
`;
}

function readEnsureDockerBody(): string {
  const p = resolveEnsureDockerScriptPath();
  if (!p) {
    throw new Error("ensure_docker_script_missing");
  }
  return fs.readFileSync(p, "utf8");
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export function dockerManualInstallCommand(os: string): string {
  if (os === "windows") {
    return DOCKER_DESKTOP_URL;
  }
  return "curl -fsSL https://playon.games/ensure-docker | sudo bash";
}

export class InstallDockerService {
  constructor(
    private readonly db: Db,
    private readonly config: AppConfig,
    private readonly sshExec: SshExec = defaultSshExec,
  ) {}

  async createToken(nodeId: string): Promise<{
    token: string;
    nodeId: string;
    oneLiner: string;
    expiresAt: string;
    manualCommand: string;
  }> {
    const row = await this.requireLinuxNode(nodeId);
    const token = nanoid(24);
    const expiresAt = Date.now() + 30 * 60 * 1000;
    installDockerTokens.set(token, { token, nodeId: row.id, expiresAt });
    const base = `http://${this.config.advertiseHost}:${this.config.port}`;
    const oneLiner = `curl -fsSL ${base}/api/nodes/${encodeURIComponent(row.id)}/install-docker/${token} | sudo bash`;
    return {
      token,
      nodeId: row.id,
      oneLiner,
      expiresAt: new Date(expiresAt).toISOString(),
      manualCommand: dockerManualInstallCommand(row.os),
    };
  }

  async scriptForToken(nodeId: string, token: string): Promise<string> {
    const rec = installDockerTokens.get(token);
    if (!rec || rec.nodeId !== nodeId || rec.expiresAt < Date.now()) {
      installDockerTokens.delete(token);
      throw new Error("install_docker_token_invalid");
    }
    // Single-use
    installDockerTokens.delete(token);
    await this.requireLinuxNode(nodeId);
    return buildInstallDockerScript();
  }

  async installViaSsh(opts: {
    nodeId: string;
    host: string;
    port?: number;
    username: string;
    password?: string;
    privateKey?: string;
    readyTimeoutMs?: number;
  }): Promise<{ nodeId: string; detail: string }> {
    if (!opts.password && !opts.privateKey) {
      throw new Error("ssh_auth_required");
    }
    const row = await this.requireLinuxNode(opts.nodeId);
    const script = buildInstallDockerScript();
    const result = await this.sshExec({
      host: opts.host,
      port: opts.port ?? 22,
      username: opts.username,
      password: opts.password,
      privateKey: opts.privateKey,
      readyTimeoutMs: opts.readyTimeoutMs ?? 180_000,
      script: `bash -lc ${shellQuote(script)}`,
    });
    if (result.code !== 0) {
      throw new Error(
        `ssh_install_docker_failed: exit ${result.code}: ${(result.stderr || result.stdout).slice(0, 400)}`,
      );
    }
    return { nodeId: row.id, detail: "install_docker_ok_waiting_heartbeat" };
  }

  private async requireLinuxNode(nodeId: string): Promise<{
    id: string;
    os: string;
    docker: boolean;
  }> {
    const id = nodeId.trim() || LOCAL_NODE_ID;
    const rows = await this.db.select().from(nodes).where(eq(nodes.id, id)).limit(1);
    const row = rows[0];
    if (!row) throw new Error(`unknown_node: ${id}`);
    if (row.os === "windows") {
      throw new Error(`install_docker_windows_unsupported: ${DOCKER_DESKTOP_URL}`);
    }
    return { id: row.id, os: row.os, docker: row.docker };
  }
}

/** Test helper */
export function clearInstallDockerTokensForTests(): void {
  installDockerTokens.clear();
}
