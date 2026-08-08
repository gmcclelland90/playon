import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  HttpError,
  defaultCodeForStatus,
  isHttpError,
  isZodLikeError,
  messageFromError,
  toErrorResult,
  validationIssuesFrom,
} from "./errors.js";

describe("HttpError", () => {
  it("defaults the code from the status", () => {
    expect(HttpError.forbidden().envelope).toEqual({ error: "forbidden", code: "forbidden" });
    expect(HttpError.notFound().status).toBe(404);
    expect(defaultCodeForStatus(409)).toBe("conflict");
  });

  it("keeps a route-specific code and details", () => {
    const err = HttpError.conflict("already_setup", {
      code: "already_setup",
      details: { userCount: 1 },
    });
    expect(err.envelope).toEqual({
      error: "already_setup",
      code: "already_setup",
      details: { userCount: 1 },
    });
  });

  it("omits details when absent", () => {
    expect(HttpError.badRequest("stop_failed", { code: "server_stop_failed" }).envelope).toEqual({
      error: "stop_failed",
      code: "server_stop_failed",
    });
  });

  it("recognises its own instances and structural clones", () => {
    expect(isHttpError(HttpError.unauthorized())).toBe(true);
    expect(isHttpError({ name: "HttpError", status: 403, message: "forbidden" })).toBe(true);
    expect(isHttpError(new Error("boom"))).toBe(false);
    expect(isHttpError(null)).toBe(false);
  });
});

describe("toErrorResult", () => {
  it("passes an HttpError straight through", () => {
    const result = toErrorResult(HttpError.notFound("not_found", { code: "server_not_found" }));
    expect(result).toEqual({
      status: 404,
      body: { error: "not_found", code: "server_not_found" },
    });
  });

  it("maps validation failures to 400 invalid_request with issues", () => {
    const parsed = z.object({ username: z.string().min(3) }).safeParse({ username: "a" });
    expect(parsed.success).toBe(false);
    const result = toErrorResult(parsed.success ? undefined : parsed.error);
    expect(result.status).toBe(400);
    expect(result.body.code).toBe("invalid_request");
    expect(result.body.details).toEqual({
      issues: [expect.objectContaining({ path: "username", code: "too_small" })],
    });
  });

  it("keeps unrecognised errors opaque so internals cannot leak", () => {
    const result = toErrorResult(new Error("sqlite: /home/me/secret.db is locked"));
    expect(result).toEqual({
      status: 500,
      body: { error: "internal_error", code: "internal_error" },
    });
  });

  it("uses the caller fallback, including opt-in message exposure", () => {
    expect(toErrorResult("nope", { status: 400, error: "stop_failed", code: "x" })).toEqual({
      status: 400,
      body: { error: "stop_failed", code: "x" },
    });
    expect(
      toErrorResult(new Error("unknown_server:abc"), {
        status: 400,
        error: "stop_failed",
        code: "server_stop_failed",
        exposeMessage: true,
      }).body.error,
    ).toBe("unknown_server:abc");
  });

  it("falls back to 500 for an out-of-range HttpError status", () => {
    expect(toErrorResult({ name: "HttpError", status: 418, message: "teapot" }).status).toBe(500);
  });
});

describe("validation helpers", () => {
  it("detects zod errors without instanceof", () => {
    const zodLike = { name: "ZodError", issues: [{ path: ["a", 0], message: "bad" }] };
    expect(isZodLikeError(zodLike)).toBe(true);
    expect(isZodLikeError(new Error("ZodError"))).toBe(false);
    expect(validationIssuesFrom(zodLike)).toEqual([{ path: "a.0", message: "bad" }]);
    expect(validationIssuesFrom(new Error("x"))).toEqual([]);
  });

  it("prefers an error message over the fallback", () => {
    expect(messageFromError(new Error("boom"), "fallback")).toBe("boom");
    expect(messageFromError(new Error("   "), "fallback")).toBe("fallback");
    expect(messageFromError("string throw", "fallback")).toBe("fallback");
  });
});
