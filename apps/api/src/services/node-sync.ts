/**
 * Sync server data trees between control plane and remote/cloud nodes via archive jobs.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isLocalNodeId } from "@playon/shared";
import { dispatchNodeJob, nodeServerRelPath } from "./node-runtime.js";

function tarAvailable(): boolean {
  try {
    execFileSync("tar", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** Pack a local directory to base64 tar (ustar). */
export function packDirToBase64(dir: string): string {
  if (!fs.existsSync(dir)) {
    return Buffer.from("").toString("base64");
  }
  if (!tarAvailable()) {
    throw new Error("tar_unavailable");
  }
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), "playon-pack-"));
  const archive = path.join(staging, "tree.tar");
  try {
    execFileSync("tar", ["-cf", archive, "-C", dir, "."], { stdio: "pipe" });
    return fs.readFileSync(archive).toString("base64");
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

export function unpackBase64ToDir(archiveBase64: string, dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  if (!archiveBase64) return;
  if (!tarAvailable()) throw new Error("tar_unavailable");
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), "playon-unpack-"));
  const archive = path.join(staging, "tree.tar");
  try {
    fs.writeFileSync(archive, Buffer.from(archiveBase64, "base64"));
    execFileSync("tar", ["-xf", archive, "-C", dir], { stdio: "pipe" });
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

/** Push control-plane server dir → remote node servers/<id>. */
export async function pushServerDirToNode(opts: {
  nodeId: string;
  serverId: string;
  localDataPath: string;
}): Promise<void> {
  if (isLocalNodeId(opts.nodeId)) return;
  const archiveBase64 = packDirToBase64(opts.localDataPath);
  await dispatchNodeJob({
    nodeId: opts.nodeId,
    kind: "fs_put_archive",
    args: {
      path: nodeServerRelPath(opts.serverId),
      archiveBase64,
      format: "tar",
    },
    timeoutMs: 600_000,
    localHandler: async () => ({ ok: true }),
  });
}

/** Pull remote node servers/<id> → local data path (replaces contents). */
export async function pullServerDirFromNode(opts: {
  nodeId: string;
  serverId: string;
  localDataPath: string;
}): Promise<void> {
  if (isLocalNodeId(opts.nodeId)) return;
  const result = await dispatchNodeJob<{ archiveBase64: string }>({
    nodeId: opts.nodeId,
    kind: "fs_get_archive",
    args: {
      path: nodeServerRelPath(opts.serverId),
      format: "tar",
    },
    timeoutMs: 600_000,
    localHandler: async () => ({ archiveBase64: "" }),
  });
  fs.rmSync(opts.localDataPath, { recursive: true, force: true });
  unpackBase64ToDir(result.archiveBase64 ?? "", opts.localDataPath);
}
