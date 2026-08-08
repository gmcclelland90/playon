import { z } from "zod";

/**
 * Every non-2xx JSON response from the control plane carries this shape:
 * `error` is human text, `code` is the stable token machine clients branch on.
 */
export const HttpErrorEnvelopeSchema = z.object({
  error: z.string().min(1),
  code: z.string().min(1).optional(),
  details: z.unknown().optional(),
});

export type HttpErrorEnvelope = {
  error: string;
  code?: string;
  details?: unknown;
};

/** Statuses the transport layer is allowed to produce for an envelope. */
export const HTTP_ERROR_STATUSES = [400, 401, 403, 404, 409, 422, 429, 500, 502, 503] as const;

export type HttpErrorStatus = (typeof HTTP_ERROR_STATUSES)[number];

/** Codes with cross-route meaning; routes may add their own on top of these. */
export const WELL_KNOWN_HTTP_ERROR_CODES = [
  "invalid_request",
  "unauthorized",
  "forbidden",
  "not_found",
  "conflict",
  "unprocessable",
  "rate_limited",
  "internal_error",
  "bad_gateway",
  "unavailable",
] as const;

export type WellKnownHttpErrorCode = (typeof WELL_KNOWN_HTTP_ERROR_CODES)[number];

export type HttpErrorCode = WellKnownHttpErrorCode | (string & {});

const CODE_BY_STATUS: Record<HttpErrorStatus, WellKnownHttpErrorCode> = {
  400: "invalid_request",
  401: "unauthorized",
  403: "forbidden",
  404: "not_found",
  409: "conflict",
  422: "unprocessable",
  429: "rate_limited",
  500: "internal_error",
  502: "bad_gateway",
  503: "unavailable",
};

export function defaultCodeForStatus(status: HttpErrorStatus): WellKnownHttpErrorCode {
  return CODE_BY_STATUS[status];
}

export type HttpErrorInit = {
  code?: HttpErrorCode;
  details?: unknown;
  cause?: unknown;
};

/**
 * Thrown by routes and policy helpers; the transport error handler turns it into
 * the envelope. Factories are static so `@playon/shared` keeps a tidy namespace.
 */
export class HttpError extends Error {
  readonly status: HttpErrorStatus;
  readonly code: HttpErrorCode;
  readonly details: unknown;

  constructor(status: HttpErrorStatus, error: string, init: HttpErrorInit = {}) {
    super(error, init.cause === undefined ? undefined : { cause: init.cause });
    this.name = "HttpError";
    this.status = status;
    this.code = init.code ?? defaultCodeForStatus(status);
    this.details = init.details;
  }

  get envelope(): HttpErrorEnvelope {
    const body: HttpErrorEnvelope = { error: this.message, code: this.code };
    if (this.details !== undefined) body.details = this.details;
    return body;
  }

  static badRequest(error = "invalid_request", init?: HttpErrorInit): HttpError {
    return new HttpError(400, error, init);
  }

  static unauthorized(error = "unauthorized", init?: HttpErrorInit): HttpError {
    return new HttpError(401, error, init);
  }

  static forbidden(error = "forbidden", init?: HttpErrorInit): HttpError {
    return new HttpError(403, error, init);
  }

  static notFound(error = "not_found", init?: HttpErrorInit): HttpError {
    return new HttpError(404, error, init);
  }

  static conflict(error = "conflict", init?: HttpErrorInit): HttpError {
    return new HttpError(409, error, init);
  }

  static unprocessable(error = "unprocessable", init?: HttpErrorInit): HttpError {
    return new HttpError(422, error, init);
  }

  static rateLimited(error = "rate_limited", init?: HttpErrorInit): HttpError {
    return new HttpError(429, error, init);
  }

  static internal(error = "internal_error", init?: HttpErrorInit): HttpError {
    return new HttpError(500, error, init);
  }

  /** An upstream the control plane depends on (catalog, relay) failed us. */
  static badGateway(error = "bad_gateway", init?: HttpErrorInit): HttpError {
    return new HttpError(502, error, init);
  }

  static unavailable(error = "unavailable", init?: HttpErrorInit): HttpError {
    return new HttpError(503, error, init);
  }
}

export function isHttpError(value: unknown): value is HttpError {
  if (value instanceof HttpError) return true;
  if (!value || typeof value !== "object") return false;
  const candidate = value as { name?: unknown; status?: unknown; message?: unknown };
  return (
    candidate.name === "HttpError" &&
    typeof candidate.status === "number" &&
    typeof candidate.message === "string"
  );
}

export type ValidationIssue = {
  path: string;
  message: string;
  code?: string;
};

type ZodLikeError = {
  name: string;
  issues: Array<{ path?: unknown; message?: unknown; code?: unknown }>;
};

/**
 * Duck-typed on purpose: API, shared and web can each resolve their own copy of
 * zod, so `instanceof ZodError` is not reliable across the package boundary.
 */
export function isZodLikeError(value: unknown): value is ZodLikeError {
  if (!value || typeof value !== "object") return false;
  const candidate = value as { name?: unknown; issues?: unknown };
  return candidate.name === "ZodError" && Array.isArray(candidate.issues);
}

export function validationIssuesFrom(err: unknown): ValidationIssue[] {
  if (!isZodLikeError(err)) return [];
  return err.issues.map((issue) => {
    const path = Array.isArray(issue.path) ? issue.path.join(".") : "";
    const mapped: ValidationIssue = {
      path,
      message: typeof issue.message === "string" ? issue.message : "invalid",
    };
    if (typeof issue.code === "string") mapped.code = issue.code;
    return mapped;
  });
}

export function messageFromError(err: unknown, fallback: string): string {
  if (err instanceof Error && err.message.trim()) return err.message;
  return fallback;
}

export type HttpErrorResult = {
  status: HttpErrorStatus;
  body: HttpErrorEnvelope;
};

export type HttpErrorFallback = {
  status?: HttpErrorStatus;
  error?: string;
  code?: HttpErrorCode;
  /** Opt in to surfacing an unrecognised `Error.message` instead of the fallback text. */
  exposeMessage?: boolean;
};

/**
 * Single mapping from anything thrown in a route to an envelope. Unrecognised
 * errors stay opaque (500 `internal_error`) so service internals and secrets do
 * not leak into client payloads.
 */
export function toErrorResult(err: unknown, fallback: HttpErrorFallback = {}): HttpErrorResult {
  if (isHttpError(err)) {
    const status = (HTTP_ERROR_STATUSES as readonly number[]).includes(err.status)
      ? err.status
      : 500;
    const body: HttpErrorEnvelope = {
      error: err.message,
      code: err.code ?? defaultCodeForStatus(status),
    };
    if (err.details !== undefined) body.details = err.details;
    return { status, body };
  }

  if (isZodLikeError(err)) {
    return {
      status: 400,
      body: {
        error: fallback.error ?? "invalid_request",
        code: fallback.code ?? "invalid_request",
        details: { issues: validationIssuesFrom(err) },
      },
    };
  }

  const status = fallback.status ?? 500;
  const error = fallback.exposeMessage
    ? messageFromError(err, fallback.error ?? defaultCodeForStatus(status))
    : (fallback.error ?? defaultCodeForStatus(status));
  return {
    status,
    body: { error, code: fallback.code ?? defaultCodeForStatus(status) },
  };
}
