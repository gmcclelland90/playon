import { describe, expect, it } from "vitest";
import {
  HTTP_ERROR_STATUSES,
  HttpError,
  HttpErrorEnvelopeSchema,
  WELL_KNOWN_HTTP_ERROR_CODES,
  defaultCodeForStatus,
} from "./errors.js";

/**
 * Wire contract for error responses. Codes and statuses here are what machine
 * clients (web, MCP, node-agent, scripts) are allowed to branch on, so changes
 * must be additive.
 */
describe("http error envelope contract", () => {
  it("accepts the minimal and full shapes", () => {
    expect(HttpErrorEnvelopeSchema.safeParse({ error: "forbidden" }).success).toBe(true);
    expect(
      HttpErrorEnvelopeSchema.safeParse({
        error: "invalid_request",
        code: "invalid_request",
        details: { issues: [{ path: "username", message: "too short" }] },
      }).success,
    ).toBe(true);
  });

  it("rejects bodies without human text", () => {
    expect(HttpErrorEnvelopeSchema.safeParse({}).success).toBe(false);
    expect(HttpErrorEnvelopeSchema.safeParse({ error: "" }).success).toBe(false);
    expect(HttpErrorEnvelopeSchema.safeParse({ error: 404 }).success).toBe(false);
  });

  it("pins the well-known codes", () => {
    expect([...WELL_KNOWN_HTTP_ERROR_CODES]).toEqual([
      "invalid_request",
      "unauthorized",
      "forbidden",
      "not_found",
      "conflict",
      "unprocessable",
      "rate_limited",
      "internal_error",
      "unavailable",
    ]);
  });

  it("gives every supported status a well-known default code", () => {
    for (const status of HTTP_ERROR_STATUSES) {
      const code = defaultCodeForStatus(status);
      expect(WELL_KNOWN_HTTP_ERROR_CODES).toContain(code);
      expect(HttpErrorEnvelopeSchema.safeParse({ error: code, code }).success).toBe(true);
    }
  });

  it("emits a schema-valid envelope for each factory", () => {
    const errors = [
      HttpError.badRequest(),
      HttpError.unauthorized(),
      HttpError.forbidden(),
      HttpError.notFound(),
      HttpError.conflict(),
      HttpError.unprocessable(),
      HttpError.rateLimited(),
      HttpError.internal(),
      HttpError.unavailable(),
    ];
    for (const err of errors) {
      expect(HTTP_ERROR_STATUSES).toContain(err.status);
      expect(HttpErrorEnvelopeSchema.safeParse(err.envelope).success).toBe(true);
    }
  });
});
