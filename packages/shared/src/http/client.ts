import {
  HttpErrorEnvelopeSchema,
  type HttpErrorCode,
  type HttpErrorEnvelope,
} from "./errors.js";

/**
 * Thrown by HTTP clients (web `request()`, scripts) after a non-2xx response.
 * `message` stays the server's human text so existing UI that renders
 * `err.message` keeps working; `code` is what new branching should use.
 */
export class ApiRequestError extends Error {
  readonly status: number;
  readonly code: HttpErrorCode | undefined;
  readonly details: unknown;

  constructor(
    message: string,
    init: { status: number; code?: HttpErrorCode; details?: unknown },
  ) {
    super(message);
    this.name = "ApiRequestError";
    this.status = init.status;
    this.code = init.code;
    this.details = init.details;
  }
}

export function isApiRequestError(value: unknown): value is ApiRequestError {
  if (value instanceof ApiRequestError) return true;
  if (!value || typeof value !== "object") return false;
  const candidate = value as { name?: unknown; status?: unknown };
  return candidate.name === "ApiRequestError" && typeof candidate.status === "number";
}

/** Returns the envelope when the body matches it, otherwise undefined. */
export function parseErrorEnvelope(body: unknown): HttpErrorEnvelope | undefined {
  const parsed = HttpErrorEnvelopeSchema.safeParse(body);
  if (!parsed.success) return undefined;
  const envelope: HttpErrorEnvelope = { error: parsed.data.error.trim() };
  if (!envelope.error) return undefined;
  if (parsed.data.code) envelope.code = parsed.data.code;
  if (parsed.data.details !== undefined) envelope.details = parsed.data.details;
  return envelope;
}

/**
 * Builds the typed client error for a failed response. Bodies that predate the
 * envelope (or aren't JSON at all) still produce a usable `request_failed_<status>`.
 */
export function apiErrorFromResponse(
  status: number,
  body: unknown,
  fallbackMessage = `request_failed_${status}`,
): ApiRequestError {
  const envelope = parseErrorEnvelope(body);
  return new ApiRequestError(envelope?.error ?? fallbackMessage, {
    status,
    ...(envelope?.code ? { code: envelope.code } : {}),
    ...(envelope && envelope.details !== undefined ? { details: envelope.details } : {}),
  });
}
