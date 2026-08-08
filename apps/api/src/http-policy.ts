import {
  HttpError,
  can,
  isZodLikeError,
  roleAtLeast,
  validationIssuesFrom,
  type Capability,
  type HttpErrorCode,
  type Role,
} from "@playon/shared";
import type { AuthUser } from "./auth/session.js";

/** Minimal view of the Hono context these guards need. */
export type SessionCarrier = {
  get(key: "user"): AuthUser | null;
};

export function currentUser(c: SessionCarrier): AuthUser | null {
  return c.get("user") ?? null;
}

/** 401 when there is no session — for routes that only need "who is this". */
export function requireSession(c: SessionCarrier): AuthUser {
  const user = currentUser(c);
  if (!user) throw HttpError.unauthorized("unauthorized");
  return user;
}

/**
 * Authorization guards answer 403 for anonymous callers too. That mirrors the
 * pre-envelope routes (clients treat "not allowed" uniformly) and avoids leaking
 * which endpoints exist to unauthenticated probes.
 */
export function requireRole(c: SessionCarrier, role: Role): AuthUser {
  const user = currentUser(c);
  if (!user || !roleAtLeast(user.role, role)) throw HttpError.forbidden("forbidden");
  return user;
}

export function requireCan(c: SessionCarrier, capability: Capability): AuthUser {
  const user = currentUser(c);
  if (!user || !can(user.role, capability)) throw HttpError.forbidden("forbidden");
  return user;
}

/** Minimal view of the Hono context `jsonBody` needs. */
export type JsonBodyCarrier = {
  req: { json(): Promise<unknown> };
};

export type BodySchema<T> = {
  parse(value: unknown): T;
};

/**
 * Reads and validates a JSON request body. Unparseable JSON is a client mistake,
 * so it answers 400 `invalid_json` rather than escaping as an unhandled 500;
 * schema failures fall through to the shared 400 `invalid_request` envelope.
 */
export async function jsonBody<T>(c: JsonBodyCarrier, schema: BodySchema<T>): Promise<T> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch (err) {
    throw HttpError.badRequest("invalid_json", { code: "invalid_json", cause: err });
  }
  return schema.parse(raw);
}

export type ServiceFailure = {
  /** Envelope text when the thrown value is not an `Error`. */
  fallback: string;
  code: HttpErrorCode;
  /** Message prefixes that mean "the thing isn't there" rather than "bad request". */
  notFoundPrefixes?: string[];
};

/**
 * Wraps a service rejection into an `HttpError` while keeping the service's
 * message as the human text, which existing clients already display.
 */
export function serviceHttpError(err: unknown, failure: ServiceFailure): HttpError {
  if (err instanceof HttpError) return err;
  // A schema failure inside the try block would otherwise become the raw zod
  // JSON dump as human text.
  if (isZodLikeError(err)) {
    return HttpError.badRequest("invalid_request", {
      code: "invalid_request",
      details: { issues: validationIssuesFrom(err) },
      cause: err,
    });
  }
  const message = err instanceof Error && err.message.trim() ? err.message : failure.fallback;
  const notFound = (failure.notFoundPrefixes ?? []).some((prefix) => message.startsWith(prefix));
  const init = { code: failure.code, cause: err };
  return notFound ? HttpError.notFound(message, init) : HttpError.badRequest(message, init);
}
