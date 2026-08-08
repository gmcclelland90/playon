import { describe, expect, it } from "vitest";
import { HttpError } from "./errors.js";
import { ApiRequestError, apiErrorFromResponse, isApiRequestError, parseErrorEnvelope } from "./client.js";

describe("parseErrorEnvelope", () => {
  it("accepts the envelope and drops empty text", () => {
    expect(parseErrorEnvelope({ error: "forbidden", code: "forbidden" })).toEqual({
      error: "forbidden",
      code: "forbidden",
    });
    expect(parseErrorEnvelope({ error: "  " })).toBeUndefined();
    expect(parseErrorEnvelope({ ok: false })).toBeUndefined();
    expect(parseErrorEnvelope(undefined)).toBeUndefined();
  });

  it("keeps details when present", () => {
    expect(
      parseErrorEnvelope({ error: "invalid_request", details: { issues: [] } }),
    ).toEqual({ error: "invalid_request", details: { issues: [] } });
  });
});

describe("apiErrorFromResponse", () => {
  it("round-trips a server envelope into a typed client error", () => {
    const envelope = HttpError.conflict("already_setup", { code: "already_setup" }).envelope;
    const err = apiErrorFromResponse(409, envelope);
    expect(err).toBeInstanceOf(ApiRequestError);
    expect(isApiRequestError(err)).toBe(true);
    expect(err.message).toBe("already_setup");
    expect(err.code).toBe("already_setup");
    expect(err.status).toBe(409);
  });

  it("falls back for bodies that are not an envelope", () => {
    const err = apiErrorFromResponse(502, undefined);
    expect(err.message).toBe("request_failed_502");
    expect(err.code).toBeUndefined();
  });

  it("honours a caller fallback message", () => {
    expect(apiErrorFromResponse(500, {}, "export_failed").message).toBe("export_failed");
  });

  it("is not mistaken for an unrelated error", () => {
    expect(isApiRequestError(new Error("boom"))).toBe(false);
  });
});
