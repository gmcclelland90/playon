/**
 * Unified Add-a-node: SSH (or script) bootstrap for LAN and Cloud machines.
 */
import { Client } from "ssh2";
import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import {
  CLOUD_OVERLAY_HOME_IP,
  LOCAL_NODE_ID,
  type NodeKind,
} from "@playon/shared";
import type { AppConfig } from "../../config.js";
import type { Db } from "../../db/client.js";
import { nodes, servers } from "../../db/schema.js";
import type { TunnelService } from "./tunnel.js";

export type AddNodeKind = Exclude<NodeKind, "local">;

export type AddNodeSshArgs = {
  kind: AddNodeKind;
  host: string;
  port?: number;
  username: string;
  password?: string;
  privateKey?: string;
  nodeId?: string;
  nodeName?: string;
  /** Cloud WG listen port on the VPS (default 51820). */
  wgListenPort?: number;
  readyTimeoutMs?: number;
  /** Wait for first agent heartbeat after SSH (default 90s). 0 = skip. */
  heartbeatWaitMs?: number;
};

export type AddNodeResult = {
  nodeId: string;
  kind: AddNodeKind;
  name: string;
  oneLiner?: string;
  overlayIp?: string;
  tunnelStatus?: string;
  detail: string;
};

export type BootstrapTokenRecord = {
  token: string;
  kind: AddNodeKind;
  nodeId: string;
  name: string;
  expiresAt: number;
  /** Cloud: VPS public hostname/IP for WireGuard Endpoint. */
  endpointHost?: string;
};

const bootstrapTokens = new Map<string, BootstrapTokenRecord>();

export type SshExec = (args: {
  host: string;
  port: number;
  username: string;
  password?: string;
  privateKey?: string;
  readyTimeoutMs: number;
  script: string;
  /** Written to remote stdin before close (e.g. sudo -S password). */
  stdin?: string;
}) => Promise<{ stdout: string; stderr: string; code: number }>;

export const defaultSshExec: SshExec = (args) =>
  new Promise((resolve, reject) => {
    const conn = new Client();
    const timer = setTimeout(() => {
      conn.end();
      reject(new Error("ssh_timeout"));
    }, args.readyTimeoutMs);

    conn
      .on("ready", () => {
        conn.exec(args.script, (err, stream) => {
          if (err || !stream) {
            clearTimeout(timer);
            conn.end();
            return reject(err ?? new Error("ssh_exec_failed"));
          }
          let stdout = "";
          let stderr = "";
          stream
            .on("close", (code: number | null) => {
              clearTimeout(timer);
              conn.end();
              resolve({ stdout, stderr, code: code ?? 1 });
            })
            .on("data", (d: Buffer) => {
              stdout += d.toString("utf8");
            });
          stream.stderr.on("data", (d: Buffer) => {
            stderr += d.toString("utf8");
          });
          if (args.stdin != null) {
            stream.end(args.stdin);
          }
        });
      })
      .on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      })
      .connect({
        host: args.host,
        port: args.port,
        username: args.username,
        password: args.password,
        privateKey: args.privateKey,
        readyTimeout: args.readyTimeoutMs,
      });
  });

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * Install scripts need root. One-liner uses `| sudo bash`; SSH must elevate the same way.
 * Password is never put on the remote argv — only on stdin for `sudo -S`.
 */
export function wrapRemotePrivilegedScript(
  script: string,
  opts: { username: string; password?: string },
): { command: string; stdin?: string } {
  const quoted = shellQuote(script);
  const user = opts.username.trim();
  if (!user || user === "root") {
    return { command: `bash -lc ${quoted}` };
  }
  if (opts.password) {
    return {
      command: `sudo -S -p '' bash -lc ${quoted}`,
      stdin: `${opts.password}\n`,
    };
  }
  return { command: `sudo -n bash -lc ${quoted}` };
}

export function classifySshAuthError(err: unknown): Error {
  const message = err instanceof Error ? err.message : String(err);
  const lower = message.toLowerCase();
  if (
    lower.includes("all configured authentication methods failed") ||
    lower.includes("authentication failure") ||
    (lower.includes("permission denied") && lower.includes("publickey")) ||
    lower.includes("ssh_auth_failed")
  ) {
    return new Error("ssh_auth_failed");
  }
  if (message === "ssh_timeout" || lower.includes("ssh_timeout")) {
    return new Error("ssh_timeout");
  }
  return err instanceof Error ? err : new Error(message);
}

export function classifyBootstrapFailure(result: {
  code: number;
  stdout: string;
  stderr: string;
}): Error {
  const detail = (result.stderr || result.stdout).slice(0, 400);
  const lower = detail.toLowerCase();
  if (
    lower.includes("could not open lock file") ||
    lower.includes("unable to lock directory") ||
    lower.includes("permission denied") ||
    lower.includes("run as root") ||
    lower.includes("a password is required") ||
    lower.includes("sudo: a password is required") ||
    lower.includes("sudo: a terminal is required")
  ) {
    return new Error(`ssh_needs_root_or_sudo: exit ${result.code}: ${detail}`);
  }
  return new Error(`ssh_bootstrap_failed: exit ${result.code}: ${detail}`);
}

/** After install-node: force friendly name even when published script lacks --name. */
export function buildNodeNameOverrideSnippet(opts: {
  nodeName: string;
}): string {
  const name = opts.nodeName.trim();
  if (!name) return "";
  return `
# Keep the Home-chosen display name (works with older install-node without --name).
if [[ -f /etc/playon/node.env ]]; then
  if grep -q '^PLAYON_NODE_NAME=' /etc/playon/node.env; then
    sed -i ${shellQuote(`s|^PLAYON_NODE_NAME=.*|PLAYON_NODE_NAME=${name}|`)} /etc/playon/node.env
  else
    echo ${shellQuote(`PLAYON_NODE_NAME=${name}`)} >> /etc/playon/node.env
  fi
  systemctl restart playon-node-agent.service 2>/dev/null || true
fi
`;
}

function installNodeInvocation(opts: {
  apiUrl: string;
  nodeToken: string;
  nodeId: string;
  nodeName?: string;
}): string {
  const nameArg = opts.nodeName?.trim()
    ? ` --name ${shellQuote(opts.nodeName.trim())}`
    : "";
  return `bash /tmp/playon-install-node.sh --api ${shellQuote(opts.apiUrl)} --token ${shellQuote(opts.nodeToken)} --node-id ${shellQuote(opts.nodeId)}${nameArg} --runtime docker || \\
  bash /tmp/playon-install-node.sh --api ${shellQuote(opts.apiUrl)} --token ${shellQuote(opts.nodeToken)} --node-id ${shellQuote(opts.nodeId)}${nameArg}`;
}

export function buildLanBootstrapScript(opts: {
  apiUrl: string;
  nodeToken: string;
  nodeId: string;
  nodeName?: string;
}): string {
  const name = opts.nodeName?.trim();
  return `set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
if ! command -v curl >/dev/null 2>&1; then apt-get update -y && apt-get install -y curl; fi
# Prefer published install-node when available; fall back to agent hint.
if curl -fsSL https://playon.games/install-node -o /tmp/playon-install-node.sh 2>/dev/null; then
  ${installNodeInvocation(opts)}
else
  echo "playon_install_node_unavailable: ensure node-agent is installed manually"
  exit 2
fi
${name ? buildNodeNameOverrideSnippet({ nodeName: name }) : ""}
`;
}

export function buildCloudBootstrapScript(opts: {
  apiUrl: string;
  nodeToken: string;
  nodeId: string;
  nodeName?: string;
  wgConfig: string;
  wgListenPort: number;
}): string {
  const b64 = Buffer.from(opts.wgConfig, "utf8").toString("base64");
  const name = opts.nodeName?.trim();
  return `set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y wireguard curl
mkdir -p /etc/wireguard
echo ${shellQuote(b64)} | base64 -d > /etc/wireguard/playon0.conf
chmod 600 /etc/wireguard/playon0.conf
wg-quick down playon0 2>/dev/null || true
wg-quick up playon0
# Allow WG
if command -v ufw >/dev/null 2>&1; then ufw allow ${opts.wgListenPort}/udp || true; fi
if curl -fsSL https://playon.games/install-node -o /tmp/playon-install-node.sh 2>/dev/null; then
  ${installNodeInvocation(opts)}
else
  echo "playon_install_node_unavailable"
  exit 2
fi
${name ? buildNodeNameOverrideSnippet({ nodeName: name }) : ""}
`;
}

export class AddNodeService {
  constructor(
    private readonly db: Db,
    private readonly config: AppConfig,
    private readonly tunnel: TunnelService,
    private readonly sshExec: SshExec = defaultSshExec,
  ) {}

  private apiUrlForKind(kind: AddNodeKind): string {
    if (kind === "cloud") {
      return `http://${CLOUD_OVERLAY_HOME_IP}:${this.config.port}`;
    }
    return `http://${this.config.advertiseHost}:${this.config.port}`;
  }

  private async upsertPlaceholder(opts: {
    nodeId: string;
    name: string;
    kind: AddNodeKind;
    joinHost?: string | null;
  }): Promise<{ created: boolean }> {
    const joinHost = opts.joinHost?.trim() || null;
    const existing = await this.db.select().from(nodes).where(eq(nodes.id, opts.nodeId)).limit(1);
    if (existing[0]) {
      await this.db
        .update(nodes)
        .set({
          name: opts.name,
          kind: opts.kind,
          lastSeenAt: existing[0].lastSeenAt,
          tunnelStatus: opts.kind === "cloud" ? "pending" : "none",
          ...(joinHost ? { joinHost } : {}),
        })
        .where(eq(nodes.id, opts.nodeId));
      return { created: false };
    }
    // Epoch lastSeen so presence is offline until the agent heartbeats (avoid online→stale flash).
    await this.db.insert(nodes).values({
      id: opts.nodeId,
      name: opts.name,
      os: "linux",
      docker: false,
      native: true,
      steamcmd: false,
      freeDiskBytes: null,
      agentVersion: "pending",
      lastSeenAt: new Date(0),
      kind: opts.kind,
      tunnelStatus: opts.kind === "cloud" ? "pending" : "none",
      joinHost,
    });
    return { created: true };
  }

  private async waitForHeartbeat(
    nodeId: string,
    timeoutMs: number = 90_000,
  ): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const row = await this.db.select().from(nodes).where(eq(nodes.id, nodeId)).limit(1);
      if (row[0] && row[0].agentVersion && row[0].agentVersion !== "pending") {
        return true;
      }
      await new Promise((r) => setTimeout(r, 1500));
    }
    return false;
  }

  /** Drop a never-heartbeated placeholder created by a failed SSH add. */
  private async cleanupFailedSshPlaceholder(opts: {
    nodeId: string;
    created: boolean;
    peerCreated: boolean;
  }): Promise<void> {
    if (opts.peerCreated) {
      await this.tunnel.removeCloudPeer(opts.nodeId).catch(() => undefined);
    }
    if (!opts.created) return;

    const row = await this.db.select().from(nodes).where(eq(nodes.id, opts.nodeId)).limit(1);
    if (!row[0] || row[0].agentVersion !== "pending") return;

    const bound = await this.db.select().from(servers).where(eq(servers.nodeId, opts.nodeId));
    if (bound.length) return;

    await this.db.delete(nodes).where(eq(nodes.id, opts.nodeId));
  }

  /** Create a short-lived one-liner token (console paste). */
  async createBootstrapToken(opts: {
    kind: AddNodeKind;
    nodeId?: string;
    nodeName?: string;
    /** Required for cloud: VPS public IP/hostname for WireGuard Endpoint. */
    endpointHost?: string;
  }): Promise<{ token: string; nodeId: string; oneLiner: string; expiresAt: string }> {
    if (!this.config.nodeToken) throw new Error("node_token_unset");
    const nodeId = opts.nodeId?.trim() || `node-${nanoid(8)}`;
    if (nodeId === LOCAL_NODE_ID) throw new Error("node_id_reserved");
    if (opts.kind === "cloud" && !opts.endpointHost?.trim()) {
      throw new Error("endpoint_host_required");
    }
    const name = opts.nodeName?.trim() || nodeId;
    const joinHost = opts.endpointHost?.trim() || null;
    await this.upsertPlaceholder({ nodeId, name, kind: opts.kind, joinHost });

    const token = nanoid(24);
    const expiresAt = Date.now() + 30 * 60 * 1000;
    bootstrapTokens.set(token, {
      token,
      kind: opts.kind,
      nodeId,
      name,
      expiresAt,
      endpointHost: opts.endpointHost?.trim(),
    });

    const base = `http://${this.config.advertiseHost}:${this.config.port}`;
    const oneLiner = `curl -fsSL ${base}/api/nodes/bootstrap/${token} | sudo bash`;
    return { token, nodeId, oneLiner, expiresAt: new Date(expiresAt).toISOString() };
  }

  /** Public script endpoint body for one-liner redeem. */
  async scriptForToken(token: string): Promise<string> {
    const rec = bootstrapTokens.get(token);
    if (!rec || rec.expiresAt < Date.now()) {
      bootstrapTokens.delete(token);
      throw new Error("bootstrap_token_invalid");
    }
    if (!this.config.nodeToken) throw new Error("node_token_unset");

    if (rec.kind === "lan") {
      return buildLanBootstrapScript({
        apiUrl: this.apiUrlForKind("lan"),
        nodeToken: this.config.nodeToken,
        nodeId: rec.nodeId,
        nodeName: rec.name,
      });
    }

    const endpointHost = rec.endpointHost;
    if (!endpointHost) throw new Error("endpoint_host_required");
    const peer = await this.tunnel.createCloudPeer({
      nodeId: rec.nodeId,
      endpointHost,
    });
    const wgConfig = await this.tunnel.remoteWgQuickConfig(peer);
    await this.tunnel.syncHomeInterface().catch(() => undefined);
    return buildCloudBootstrapScript({
      apiUrl: this.apiUrlForKind("cloud"),
      nodeToken: this.config.nodeToken,
      nodeId: rec.nodeId,
      nodeName: rec.name,
      wgConfig,
      wgListenPort: peer.listenPort,
    });
  }

  async addViaSsh(args: AddNodeSshArgs): Promise<AddNodeResult> {
    if (!args.password && !args.privateKey) {
      throw new Error("ssh_auth_required");
    }
    if (!this.config.nodeToken) throw new Error("node_token_unset");

    const nodeId = args.nodeId?.trim() || `node-${nanoid(8)}`;
    if (nodeId === LOCAL_NODE_ID) throw new Error("node_id_reserved");
    const name = args.nodeName?.trim() || nodeId;
    const { created } = await this.upsertPlaceholder({
      nodeId,
      name,
      kind: args.kind,
      joinHost: args.host,
    });

    const timeout = args.readyTimeoutMs ?? 180_000;
    let script: string;
    let overlayIp: string | undefined;
    let peerCreated = false;

    try {
      if (args.kind === "lan") {
        script = buildLanBootstrapScript({
          apiUrl: this.apiUrlForKind("lan"),
          nodeToken: this.config.nodeToken,
          nodeId,
          nodeName: name,
        });
      } else {
        if (!this.tunnel.toolsAvailable() && process.env.PLAYON_WG_MEMORY !== "1") {
          // Still allow script generation in tests with memory runner.
        }
        const peer = await this.tunnel.createCloudPeer({
          nodeId,
          endpointHost: args.host,
          listenPort: args.wgListenPort,
        });
        peerCreated = true;
        overlayIp = peer.overlayIp;
        const wgConfig = await this.tunnel.remoteWgQuickConfig(peer);
        script = buildCloudBootstrapScript({
          apiUrl: this.apiUrlForKind("cloud"),
          nodeToken: this.config.nodeToken,
          nodeId,
          nodeName: name,
          wgConfig,
          wgListenPort: peer.listenPort,
        });
        // Home side up before/while remote comes online
        await this.tunnel.syncHomeInterface().catch(async (err) => {
          await this.tunnel.markTunnelStatus(
            nodeId,
            "unconfigured",
            err instanceof Error ? err.message : "wg_sync_failed",
          );
        });
      }

      const wrapped = wrapRemotePrivilegedScript(script, {
        username: args.username,
        password: args.password,
      });
      const result = await this.sshExec({
        host: args.host,
        port: args.port ?? 22,
        username: args.username,
        password: args.password,
        privateKey: args.privateKey,
        readyTimeoutMs: timeout,
        script: wrapped.command,
        stdin: wrapped.stdin,
      });

      if (result.code !== 0) {
        throw classifyBootstrapFailure(result);
      }
    } catch (err) {
      await this.cleanupFailedSshPlaceholder({
        nodeId,
        created,
        peerCreated,
      });
      throw classifySshAuthError(err);
    }

    if (args.kind === "cloud") {
      await this.tunnel.syncHomeInterface().catch(() => undefined);
    }

    const waitMs = args.heartbeatWaitMs ?? 90_000;
    if (waitMs <= 0) {
      return {
        nodeId,
        kind: args.kind,
        name,
        overlayIp,
        tunnelStatus: args.kind === "cloud" ? "pending" : "none",
        detail: "bootstrap_ok_waiting_heartbeat",
      };
    }
    const online = await this.waitForHeartbeat(nodeId, waitMs);
    return {
      nodeId,
      kind: args.kind,
      name,
      overlayIp,
      tunnelStatus: args.kind === "cloud" ? "pending" : "none",
      detail: online ? "online" : "bootstrap_heartbeat_timeout",
    };
  }

  async removeNode(nodeId: string, opts?: { force?: boolean }): Promise<{ ok: true; detail: string }> {
    if (nodeId === LOCAL_NODE_ID) throw new Error("cannot_remove_local");
    const row = await this.db.select().from(nodes).where(eq(nodes.id, nodeId)).limit(1);
    if (!row[0]) throw new Error(`unknown_node: ${nodeId}`);

    const bound = await this.db.select().from(servers).where(eq(servers.nodeId, nodeId));
    if (bound.length && !opts?.force) {
      throw new Error(`node_has_servers: ${bound.map((s) => s.id).join(",")}`);
    }

    if (row[0].kind === "cloud") {
      await this.tunnel.removeCloudPeer(nodeId);
    }
    await this.db.delete(nodes).where(eq(nodes.id, nodeId));
    return { ok: true, detail: "node_removed" };
  }
}

/** Test helper */
export function clearBootstrapTokensForTests(): void {
  bootstrapTokens.clear();
}
