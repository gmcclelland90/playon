import { Hono } from "hono";
import { z } from "zod";
import { describe, expect, it, vi } from "vitest";
import { HttpError, type Role } from "@playon/shared";
import type { AuthUser } from "./auth/session.js";
import { httpErrorHandler } from "./http-errors.js";
import {
  currentUser,
  jsonBody,
  requireCan,
  requireNodeToken,
  requireRole,
  requireSession,
  serviceHttpError,
  sessionHasRole,
  type SessionCarrier,
} from "./http-policy.js";
import type { NodeTokenCarrier } from "./auth/node-token.js";

function carrier(role: Role | null): SessionCarrier {
  const user: AuthUser | null = role
    ? { id: "u1", username: "u", displayName: "U", role }
    : null;
  return { get: () => user };
}

describe("policy helpers", () => {
  it("returns the session user or 401", () => {
    expect(requireSession(carrier("player")).id).toBe("u1");
    expect(currentUser(carrier(null))).toBeNull();
    try {
      requireSession(carrier(null));
      expect.unreachable("requireSession must throw without a session");
    } catch (err) {
      expect(err).toBeInstanceOf(HttpError);
      expect((err as HttpError).status).toBe(401);
      expect((err as HttpError).envelope).toEqual({
        error: "unauthorized",
        code: "unauthorized",
      });
    }
  });

  it("gates on role and answers 403 for anonymous callers", () => {
    expect(requireRole(carrier("operator"), "operator").role).toBe("operator");
    expect(requireRole(carrier("owner"), "operator").role).toBe("owner");
    expect(() => requireRole(carrier("player"), "operator")).toThrow(/forbidden/);
    expect(() => requireRole(carrier(null), "operator")).toThrow(/forbidden/);
    try {
      requireRole(carrier(null), "operator");
    } catch (err) {
      expect((err as HttpError).status).toBe(403);
    }
  });

  it("gates on capability", () => {
    expect(requireCan(carrier("operator"), "servers.manage").role).toBe("operator");
    expect(() => requireCan(carrier("operator"), "users.manage")).toThrow(/forbidden/);
    expect(() => requireCan(carrier(null), "panel.read")).toThrow(/forbidden/);
  });

  it("gates node-agent routes on the shared node token", () => {
    const withBearer = (token: string): NodeTokenCarrier => ({
      req: {
        header: (name) =>
          name.toLowerCase() === "authorization" ? `Bearer ${token}` : undefined,
      },
    });
    const empty: NodeTokenCarrier = { req: { header: () => undefined } };

    expect(() => requireNodeToken(empty, undefined)).not.toThrow();
    expect(() => requireNodeToken(withBearer("secret"), "secret")).not.toThrow();
    try {
      requireNodeToken(empty, "secret");
      expect.unreachable("requireNodeToken must throw without a matching token");
    } catch (err) {
      expect(err).toBeInstanceOf(HttpError);
      expect((err as HttpError).status).toBe(401);
      expect((err as HttpError).envelope).toEqual({
        error: "unauthorized",
        code: "unauthorized",
      });
    }
  });

  it("answers the same role question without throwing, for stream upgrades", () => {
    expect(sessionHasRole(carrier("operator"), "operator")).toBe(true);
    expect(sessionHasRole(carrier("owner"), "operator")).toBe(true);
    expect(sessionHasRole(carrier("player"), "operator")).toBe(false);
    expect(sessionHasRole(carrier(null), "operator")).toBe(false);
  });
});

describe("jsonBody", () => {
  const schema = z.object({ targetNodeId: z.string().min(1) });

  it("returns the parsed body", async () => {
    const carrier = { req: { json: async () => ({ targetNodeId: "node-a" }) } };
    expect(await jsonBody(carrier, schema)).toEqual({ targetNodeId: "node-a" });
  });

  it("answers 400 invalid_json when the body is not JSON", async () => {
    await expect(
      jsonBody(
        {
          req: {
            json: async () => {
              throw new SyntaxError("Unexpected end of JSON input");
            },
          },
        },
        schema,
      ),
    ).rejects.toMatchObject({ status: 400, code: "invalid_json" });
  });

  it("lets schema failures through for the shared invalid_request envelope", async () => {
    await expect(jsonBody({ req: { json: async () => ({}) } }, schema)).rejects.toMatchObject({
      name: "ZodError",
    });
  });
});

describe("serviceHttpError", () => {
  it("keeps the service message and tags a route code", () => {
    const err = serviceHttpError(new Error("unknown_server:abc"), {
      fallback: "stop_failed",
      code: "server_stop_failed",
    });
    expect(err.status).toBe(400);
    expect(err.envelope).toEqual({
      error: "unknown_server:abc",
      code: "server_stop_failed",
    });
  });

  it("promotes configured prefixes to 404", () => {
    const err = serviceHttpError(new Error("unknown_server:abc"), {
      fallback: "delete_failed",
      code: "server_delete_failed",
      notFoundPrefixes: ["unknown_server"],
    });
    expect(err.status).toBe(404);
  });

  it("maps a service's richer failure vocabulary onto statuses", () => {
    const failure = {
      fallback: "catalog_install_failed",
      code: "skill_catalog_install_failed",
      statusPrefixes: {
        404: ["catalog_skill_not_found"],
        409: ["skill_exists"],
        502: ["skills_catalog_fetch"],
      },
    } as const;
    const statusFor = (message: string) => serviceHttpError(new Error(message), failure).status;

    expect(statusFor("catalog_skill_not_found: games.paper")).toBe(404);
    expect(statusFor("skill_exists: games.paper")).toBe(409);
    expect(statusFor("skills_catalog_fetch: 500")).toBe(502);
    expect(statusFor("catalog_sha256_mismatch")).toBe(400);
  });

  it("renders a schema failure as invalid_request instead of a zod dump", () => {
    const zodErr = (() => {
      try {
        z.object({ targetNodeId: z.string().min(1) }).parse({});
        return null;
      } catch (err) {
        return err;
      }
    })();
    const err = serviceHttpError(zodErr, {
      fallback: "relocate_failed",
      code: "server_relocate_failed",
    });
    expect(err.status).toBe(400);
    expect(err.code).toBe("invalid_request");
    expect(err.message).toBe("invalid_request");
    expect(err.details).toEqual({
      issues: [expect.objectContaining({ path: "targetNodeId" })],
    });
  });

  it("uses the fallback for non-Error throws and passes HttpError through", () => {
    expect(serviceHttpError("nope", { fallback: "stop_failed", code: "c" }).message).toBe(
      "stop_failed",
    );
    const original = HttpError.forbidden();
    expect(serviceHttpError(original, { fallback: "x", code: "c" })).toBe(original);
  });
});

describe("httpErrorHandler", () => {
  function appWith(handler: () => unknown): Hono {
    const app = new Hono();
    app.onError(httpErrorHandler);
    app.get("/boom", async () => {
      await Promise.resolve();
      handler();
      return new Response("unreachable");
    });
    return app;
  }

  it("renders an HttpError as the envelope", async () => {
    const res = await appWith(() => {
      throw HttpError.notFound("not_found", { code: "server_not_found" });
    }).request("/boom");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found", code: "server_not_found" });
  });

  it("renders schema failures as 400 invalid_request with issues", async () => {
    const res = await appWith(() => {
      z.object({ name: z.string() }).parse({});
    }).request("/boom");
    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error: string;
      code: string;
      details: { issues: Array<{ path: string }> };
    };
    expect(body.error).toBe("invalid_request");
    expect(body.code).toBe("invalid_request");
    expect(body.details.issues[0]?.path).toBe("name");
  });

  it("hides unexpected failures behind 500 internal_error and logs them", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await appWith(() => {
      throw new Error("sqlite locked at /home/me/playon.sqlite");
    }).request("/boom");
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "internal_error", code: "internal_error" });
    expect(spy).toHaveBeenCalledOnce();
    spy.mockRestore();
  });
});
