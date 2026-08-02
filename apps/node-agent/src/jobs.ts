import fs from "node:fs";
import path from "node:path";
import { resolveInJail } from "@playon/runtime";

export type RemoteJobKind = "ping" | "fs_list";

export interface RemoteJob {
  id: string;
  nodeId: string;
  kind: RemoteJobKind;
  args: Record<string, unknown>;
}

export async function claimNextJob(
  apiBase: string,
  nodeId: string,
  token?: string,
): Promise<RemoteJob | null> {
  const headers: Record<string, string> = { accept: "application/json" };
  if (token?.trim()) headers.authorization = `Bearer ${token.trim()}`;
  const res = await fetch(
    `${apiBase.replace(/\/$/, "")}/api/nodes/${encodeURIComponent(nodeId)}/jobs/next`,
    { headers },
  );
  if (res.status === 204) return null;
  if (!res.ok) {
    throw new Error(`job_claim_failed: ${res.status} ${await res.text()}`);
  }
  return (await res.json()) as RemoteJob;
}

export async function reportJobResult(
  apiBase: string,
  nodeId: string,
  jobId: string,
  body: { ok: true; result: unknown } | { ok: false; error: string },
  token?: string,
): Promise<void> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token?.trim()) headers.authorization = `Bearer ${token.trim()}`;
  const res = await fetch(
    `${apiBase.replace(/\/$/, "")}/api/nodes/${encodeURIComponent(nodeId)}/jobs/${encodeURIComponent(jobId)}/result`,
    {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    },
  );
  if (!res.ok) {
    throw new Error(`job_result_failed: ${res.status} ${await res.text()}`);
  }
}

/** Execute a claimed job locally with path jail under dataRoot. */
export function executeJob(job: RemoteJob, dataRoot: string): unknown {
  if (job.kind === "ping") {
    return {
      pong: true,
      nodeId: job.nodeId,
      dataRoot,
      at: new Date().toISOString(),
    };
  }

  if (job.kind === "fs_list") {
    const rel = typeof job.args.path === "string" ? job.args.path : ".";
    const target = resolveInJail(dataRoot, rel);
    if (!fs.existsSync(target)) throw new Error(`not_found: ${rel}`);
    const stat = fs.statSync(target);
    if (!stat.isDirectory()) throw new Error(`not_a_directory: ${rel}`);
    return {
      path: rel,
      entries: fs.readdirSync(target).map((name) => {
        const child = path.join(target, name);
        return {
          name,
          type: fs.statSync(child).isDirectory() ? ("dir" as const) : ("file" as const),
        };
      }),
    };
  }

  throw new Error(`unsupported_job_kind: ${String((job as { kind: string }).kind)}`);
}
