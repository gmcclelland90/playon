import { z } from "zod";

/**
 * Stable error codes for the node command protocol. Both shores encode failures
 * as `"<code>: <detail>"` so the wire stays a plain string (the job queue only
 * carries `error?: string`) while callers can branch on a typed code.
 */
export const NodeJobErrorCodeSchema = z.enum([
  "unsupported_job_kind",
  "timeout",
  "validation_failed",
  "node_unreachable",
  "job_failed",
  "unknown_job",
]);

export type NodeJobErrorCode = z.infer<typeof NodeJobErrorCodeSchema>;

export const NODE_JOB_ERROR_CODES = NodeJobErrorCodeSchema.options;

/**
 * Messages minted before the typed protocol. Kept so a new control plane can
 * classify failures reported by an older node-agent (and vice versa).
 */
const LEGACY_CODE_TOKENS: Record<string, NodeJobErrorCode> = {
  node_job_timeout: "timeout",
  node_job_failed: "job_failed",
  unknown_job: "unknown_job",
  missing_arg: "validation_failed",
};

export function isNodeJobErrorCode(value: unknown): value is NodeJobErrorCode {
  return NodeJobErrorCodeSchema.safeParse(value).success;
}

export function encodeNodeJobError(code: NodeJobErrorCode, detail?: string): string {
  return detail?.trim() ? `${code}: ${detail.trim()}` : code;
}

/** Recover a typed code from a wire string, or null when it is not one of ours. */
export function parseNodeJobErrorCode(message: string | null | undefined): NodeJobErrorCode | null {
  if (!message) return null;
  const token = message.split(":", 1)[0]?.trim() ?? "";
  if (isNodeJobErrorCode(token)) return token;
  const legacy = LEGACY_CODE_TOKENS[token];
  if (legacy) return legacy;
  // Older agents wrapped codes inside longer sentences.
  for (const [candidate, mapped] of Object.entries(LEGACY_CODE_TOKENS)) {
    if (message.includes(candidate)) return mapped;
  }
  for (const candidate of NODE_JOB_ERROR_CODES) {
    if (message.includes(candidate)) return candidate;
  }
  return null;
}

export class NodeJobError extends Error {
  readonly code: NodeJobErrorCode;
  readonly kind?: string;
  readonly detail?: string;

  constructor(
    code: NodeJobErrorCode,
    opts: { kind?: string; detail?: string; cause?: unknown } = {},
  ) {
    const parts = [opts.kind, opts.detail].filter((part): part is string => Boolean(part?.trim()));
    super(encodeNodeJobError(code, [...new Set(parts)].join(" ")), { cause: opts.cause });
    this.name = "NodeJobError";
    this.code = code;
    this.kind = opts.kind;
    this.detail = opts.detail;
  }
}

export function isNodeJobError(err: unknown): err is NodeJobError {
  return err instanceof NodeJobError;
}

/** True when `err` is (or decodes to) the given code, including legacy strings. */
export function hasNodeJobErrorCode(err: unknown, code: NodeJobErrorCode): boolean {
  if (isNodeJobError(err)) return err.code === code;
  const message = err instanceof Error ? err.message : typeof err === "string" ? err : null;
  return parseNodeJobErrorCode(message) === code;
}

/** Normalize anything thrown (or reported over the wire) into a typed error. */
export function toNodeJobError(
  err: unknown,
  opts: { kind?: string; fallback?: NodeJobErrorCode } = {},
): NodeJobError {
  if (isNodeJobError(err)) return err;
  const message = err instanceof Error ? err.message : typeof err === "string" ? err : "";
  const code = parseNodeJobErrorCode(message) ?? opts.fallback ?? "job_failed";
  const detail = message.startsWith(`${code}:`) ? message.slice(code.length + 1).trim() : message;
  return new NodeJobError(code, {
    kind: opts.kind && detail.includes(opts.kind) ? undefined : opts.kind,
    detail: detail || undefined,
    cause: err,
  });
}
