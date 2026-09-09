import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "./app.js";
import { hashPassword } from "./auth/password.js";
import { createSession, SESSION_COOKIE } from "./auth/session.js";
import { users } from "./db/schema.js";
import { LLM_SETTINGS_KEY, setSetting, type LlmSettings } from "./services/settings.js";
import {
  cleanupEnvelopeEnv,
  createEnvelopeEnv,
  expectForbidden,
  startConversation,
  type Envelope,
  type EnvelopeEnv,
} from "./http-envelope-routes-helpers.js";

/**
 * Split from http-envelope-routes.test.ts so Windows CI does not pack ~124s of
 * SQLite/app-bootstrap work into one vitest file near the birpc onTaskUpdate
 * cliff (#912 / vitest#6511).
 */
describe("transport error envelope — settings, chat, mcp", () => {
  let env: EnvelopeEnv;
  let db: EnvelopeEnv["db"];
  let cookie: string;
  let playerCookie: string;
  let config: EnvelopeEnv["config"];

  beforeEach(async () => {
    env = await createEnvelopeEnv();
    ({ db, cookie, playerCookie, config } = env);
  });

  afterEach(() => {
    cleanupEnvelopeEnv(env);
  });

  it("gates every settings route on the same 403 forbidden envelope", async () => {
    const app = createApp(db, config);
    await expectForbidden(app, playerCookie, [
      ["/api/settings/llm", {}],
      ["/api/settings/llm", { method: "PUT" }],
      ["/api/settings/llm/ollama/status", {}],
      ["/api/settings/llm/ollama/job", {}],
      ["/api/settings/llm/ollama/install", { method: "POST" }],
      ["/api/settings/llm/ollama/pull", { method: "POST" }],
      ["/api/settings/nodes", {}],
      ["/api/settings/nodes", { method: "PUT" }],
      ["/api/settings/fetch", {}],
      ["/api/settings/fetch", { method: "PUT" }],
      ["/api/settings/cloud", {}],
      ["/api/settings/cloud/vultr/connect", { method: "POST" }],
      ["/api/settings/cloud/vultr", { method: "DELETE" }],
      ["/api/access-tokens", {}],
      ["/api/access-tokens", { method: "POST" }],
      ["/api/access-tokens/tok-1", { method: "DELETE" }],
      ["/api/updates/status", {}],
      ["/api/updates/home/apply", { method: "POST" }],
    ]);
  });

  it("renders settings contract failures as 400 invalid_request with issues", async () => {
    const app = createApp(db, config);
    const cases: Array<[string, string, unknown, string]> = [
      ["/api/settings/llm", "PUT", {}, "preset_or_provider_required"],
      ["/api/settings/nodes", "PUT", {}, "localComputeEnabled"],
      ["/api/settings/fetch", "PUT", {}, "lanAllowlist"],
      ["/api/settings/llm/ollama/pull", "POST", {}, "model"],
    ];

    for (const [path_, method, body, expected] of cases) {
      const res = await app.request(path_, {
        method,
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      expect([path_, res.status]).toEqual([path_, 400]);
      const envelope = (await res.json()) as Envelope & {
        details?: { issues?: Array<{ path: string; message: string }> };
      };
      expect(envelope).toMatchObject({ error: "invalid_request", code: "invalid_request" });
      const issues = envelope.details?.issues ?? [];
      expect(
        issues.some((issue) => issue.path.includes(expected) || issue.message.includes(expected)),
      ).toBe(true);
    }
  });

  it("issues an access token with no request body and 404s an unknown revoke", async () => {
    const app = createApp(db, config);

    const created = await app.request("/api/access-tokens", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
    });
    expect(created.status).toBe(200);
    const createdBody = (await created.json()) as { token: { id: string; name: string } };
    expect(createdBody.token.name).toBe("MCP token");

    const revoked = await app.request(`/api/access-tokens/${createdBody.token.id}`, {
      method: "DELETE",
      headers: { cookie },
    });
    expect(revoked.status).toBe(200);

    const again = await app.request(`/api/access-tokens/${createdBody.token.id}`, {
      method: "DELETE",
      headers: { cookie },
    });
    expect(again.status).toBe(404);
    expect(await again.json()).toEqual({
      error: "not_found",
      code: "access_token_not_found",
    });
  });

  it("answers 503 when the Vultr OAuth app is not configured", async () => {
    vi.stubEnv("PLAYON_VULTR_CLIENT_ID", "");
    const app = createApp(db, config);

    const res = await app.request("/api/settings/cloud/vultr/connect", {
      method: "POST",
      headers: { cookie },
    });
    expect(res.status).toBe(503);
    const body = (await res.json()) as Envelope & { details?: { hint?: string } };
    expect(body).toMatchObject({
      error: "vultr_oauth_not_configured",
      code: "vultr_oauth_not_configured",
    });
    expect(body.details?.hint).toMatch(/PLAYON_VULTR_CLIENT_ID/);
  });

  it("answers 400 invalid_state on an unmatched Vultr callback", async () => {
    const app = createApp(db, config);
    const res = await app.request("/api/settings/cloud/vultr/callback", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ state: "nope", code: "abc" }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_state", code: "invalid_state" });
  });

  it("keeps user creation on 403 / 400 / 409 with codes", async () => {
    const app = createApp(db, config);
    await expectForbidden(app, playerCookie, [["/api/users", { method: "POST" }]]);

    const invalid = await app.request("/api/users", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ username: "ab", password: "short", role: "owner" }),
    });
    expect(invalid.status).toBe(400);
    const invalidBody = (await invalid.json()) as Envelope & {
      details?: { issues?: Array<{ path: string }> };
    };
    expect(invalidBody).toMatchObject({ error: "invalid_request", code: "invalid_request" });
    expect(invalidBody.details?.issues?.map((issue) => issue.path)).toEqual(
      expect.arrayContaining(["username", "password", "role"]),
    );

    const taken = await app.request("/api/users", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ username: "owner", password: "password123", role: "operator" }),
    });
    expect(taken.status).toBe(409);
    expect(await taken.json()).toEqual({ error: "username_taken", code: "username_taken" });

    const ok = await app.request("/api/users", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ username: "second", password: "password123", role: "operator" }),
    });
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { user: { role: string } }).user.role).toBe("operator");
  });

  /** Opens a session on `srv-1` through the route the UI uses. */

  it("gates the conversation surface on the same 403 forbidden envelope", async () => {
    const app = createApp(db, config);
    await expectForbidden(app, playerCookie, [
      ["/api/servers/srv-1/health", {}],
      ["/api/servers/srv-1/conversations", {}],
      ["/api/servers/srv-1/conversations", { method: "POST" }],
      ["/api/conversations", {}],
      ["/api/conversations", { method: "POST" }],
      ["/api/conversations/conv-1/messages", {}],
      ["/api/agents", {}],
      ["/api/activity", {}],
      ["/api/chat", { method: "POST" }],
      ["/api/confirm", { method: "POST" }],
    ]);
  });

  it("keeps server health on 400 with a route code", async () => {
    const app = createApp(db, config);
    const res = await app.request("/api/servers/ghost/health", { headers: { cookie } });
    expect(res.status).toBe(400);
    const body = (await res.json()) as Envelope;
    expect(body.code).toBe("server_health_failed");
    expect(body.error).toMatch(/unknown_server/);
  });

  it("scopes conversation routes to a known server", async () => {
    const app = createApp(db, config);
    const notFound = { error: "not_found", code: "server_not_found" };

    const list = await app.request("/api/servers/ghost/conversations", { headers: { cookie } });
    expect(list.status).toBe(404);
    expect(await list.json()).toEqual(notFound);

    const create = await app.request("/api/servers/ghost/conversations", {
      method: "POST",
      headers: { cookie },
    });
    expect(create.status).toBe(404);
    expect(await create.json()).toEqual(notFound);

    const conversationId = await startConversation(app, cookie);
    const listed = await app.request("/api/servers/srv-1/conversations", { headers: { cookie } });
    expect(listed.status).toBe(200);
    const listedBody = (await listed.json()) as { conversations: Array<{ id: string }> };
    expect(listedBody.conversations.map((row) => row.id)).toEqual([conversationId]);
  });

  it("validates the conversation title but still accepts no body at all", async () => {
    const app = createApp(db, config);

    const blank = await app.request("/api/servers/srv-1/conversations", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ title: "" }),
    });
    expect(blank.status).toBe(400);
    const blankBody = (await blank.json()) as Envelope & {
      details?: { issues?: Array<{ path: string }> };
    };
    expect(blankBody).toMatchObject({ error: "invalid_request", code: "invalid_request" });
    expect(blankBody.details?.issues?.map((issue) => issue.path)).toContain("title");

    // An unreadable body is deliberately the default session, not a 400.
    const malformed = await app.request("/api/servers/srv-1/conversations", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: "{not json",
    });
    expect(malformed.status).toBe(200);
    expect(((await malformed.json()) as { conversation: { title: string } }).conversation.title)
      .toBe("New session");
  });

  it("creates an unbound add-server conversation without a serverId", async () => {
    const app = createApp(db, config);
    const created = await app.request("/api/conversations", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ title: "Add server" }),
    });
    expect(created.status).toBe(200);
    const body = (await created.json()) as {
      conversation: { id: string; serverId: string | null; title: string };
    };
    expect(body.conversation.serverId).toBeNull();
    expect(body.conversation.title).toBe("Add server");

    const listed = await app.request("/api/conversations?unbound=1", { headers: { cookie } });
    expect(listed.status).toBe(200);
    const listedBody = (await listed.json()) as {
      conversations: Array<{ id: string; serverId: string | null }>;
    };
    expect(listedBody.conversations.map((row) => row.id)).toContain(body.conversation.id);
    expect(listedBody.conversations.every((row) => row.serverId == null)).toBe(true);
  });

  it("answers 404 for an unknown transcript and 403 for someone else's", async () => {
    const app = createApp(db, config);
    await db.insert(users).values({
      id: "admin-1",
      username: "admin",
      displayName: "Admin",
      passwordHash: hashPassword("password123"),
      role: "admin",
      createdAt: new Date(),
    });
    const adminCookie = `${SESSION_COOKIE}=${await createSession(db, "admin-1")}`;
    const conversationId = await startConversation(app, cookie);

    const mine = await app.request(`/api/conversations/${conversationId}/messages`, {
      headers: { cookie },
    });
    expect(mine.status).toBe(200);

    const theirs = await app.request(`/api/conversations/${conversationId}/messages`, {
      headers: { cookie: adminCookie },
    });
    expect(theirs.status).toBe(403);
    expect(await theirs.json()).toEqual({ error: "forbidden", code: "forbidden" });

    const ghost = await app.request("/api/conversations/ghost/messages", { headers: { cookie } });
    expect(ghost.status).toBe(404);
    expect(await ghost.json()).toEqual({ error: "not_found", code: "conversation_not_found" });
  });

  it("keeps the chat route's own request vocabulary under the envelope", async () => {
    const app = createApp(db, config);
    const post = (body: string) =>
      app.request("/api/chat", {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body,
      });

    const blank = await post(JSON.stringify({ message: "   " }));
    expect(blank.status).toBe(400);
    expect(await blank.json()).toEqual({ error: "message_required", code: "message_required" });

    const malformed = await post("{not json");
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toEqual({ error: "invalid_json", code: "invalid_json" });

    const wrongType = await post(JSON.stringify({ message: 42 }));
    expect(wrongType.status).toBe(400);
    expect((await wrongType.json()) as Envelope).toMatchObject({ code: "invalid_request" });

    const unknownConversation = await post(
      JSON.stringify({ message: "hello", conversationId: "ghost" }),
    );
    expect(unknownConversation.status).toBe(404);
    expect(await unknownConversation.json()).toEqual({
      error: "conversation_not_found",
      code: "conversation_not_found",
    });

    const unknownServer = await post(JSON.stringify({ message: "hello", serverId: "ghost" }));
    expect(unknownServer.status).toBe(404);
    expect(await unknownServer.json()).toEqual({
      error: "server_not_found",
      code: "server_not_found",
    });
  });

  it("answers 400 serverId_mismatch when the conversation is bound elsewhere", async () => {
    const app = createApp(db, config);
    const conversationId = await startConversation(app, cookie);

    const res = await app.request("/api/chat", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ message: "hello", conversationId, serverId: "srv-2" }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "serverId_mismatch",
      code: "serverId_mismatch",
    });
  });

  it("surfaces a chat turn with no usable LLM key as 400 llm_api_key_required", async () => {
    await setSetting<LlmSettings>(db, LLM_SETTINGS_KEY, {
      provider: "openai_compatible",
      preset: "openai",
      model: "gpt-4.1",
    });
    const app = createApp(db, config);
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await app.request("/api/chat", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ message: "hello" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as Envelope;
    expect(body.code).toBe("llm_api_key_required");
    expect(body.error).toMatch(/llm_api_key_required/);
    spy.mockRestore();
  });

  it("keeps confirm on 404 unknown_or_expired_request and validates the body", async () => {
    const app = createApp(db, config);
    const post = (body: string) =>
      app.request("/api/confirm", {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body,
      });

    const unknown = await post(JSON.stringify({ requestId: "req-ghost", approved: true }));
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toEqual({
      error: "unknown_or_expired_request",
      code: "unknown_or_expired_request",
    });

    const missingDecision = await post(JSON.stringify({ requestId: "req-1" }));
    expect(missingDecision.status).toBe(400);
    const missingBody = (await missingDecision.json()) as Envelope & {
      details?: { issues?: Array<{ path: string }> };
    };
    expect(missingBody).toMatchObject({ error: "invalid_request", code: "invalid_request" });
    expect(missingBody.details?.issues?.map((issue) => issue.path)).toContain("approved");

    const malformed = await post("{not json");
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toEqual({ error: "invalid_json", code: "invalid_json" });
  });

  it("keeps the agent progress and activity feeds readable behind the guards", async () => {
    const app = createApp(db, config);

    const agents = await app.request("/api/agents", { headers: { cookie } });
    expect(agents.status).toBe(200);
    expect(((await agents.json()) as { agent: { name: string } }).agent.name).toBe("Agent");

    const activity = await app.request("/api/activity", { headers: { cookie } });
    expect(activity.status).toBe(200);
    expect(((await activity.json()) as { activity: unknown[] }).activity).toEqual([]);
  });

  it("gates node-token protocol routes on the shared 401 unauthorized envelope", async () => {
    config.nodeToken = "envelope-node-token";
    const app = createApp(db, config);
    const unauthorized = { error: "unauthorized", code: "unauthorized" };
    const attempts: Array<[string, RequestInit]> = [
      ["/api/nodes/heartbeat", { method: "POST", body: "{}" }],
      ["/api/nodes/node-a/logs", { method: "POST", body: "{}" }],
      ["/api/nodes/node-a/metrics", { method: "POST", body: "{}" }],
      ["/api/nodes/node-a/jobs/next", {}],
      ["/api/nodes/node-a/jobs/job-1/result", { method: "POST", body: "{}" }],
    ];

    for (const [path_, init] of attempts) {
      const res = await app.request(path_, {
        ...init,
        headers: { "content-type": "application/json", ...(init.headers ?? {}) },
      });
      expect([path_, res.status]).toEqual([path_, 401]);
      expect(await res.json()).toEqual(unauthorized);
    }
  });

  it("renders node-token body failures as 400 invalid_request with issues", async () => {
    config.nodeToken = "envelope-node-token";
    const app = createApp(db, config);
    const auth = { authorization: "Bearer envelope-node-token" };

    const enqueued = await app.request("/api/nodes/node-a/jobs", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ kind: "ping" }),
    });
    expect(enqueued.status).toBe(201);
    const jobId = ((await enqueued.json()) as { job: { id: string } }).job.id;

    const cases: Array<[string, unknown, string]> = [
      ["/api/nodes/heartbeat", { nodeId: "n1" }, "name"],
      ["/api/nodes/node-a/logs", { serverId: "srv-1" }, "lines"],
      ["/api/nodes/node-a/metrics", { cpuPercent: 200 }, "cpuPercent"],
    ];

    for (const [path_, body, expected] of cases) {
      const res = await app.request(path_, {
        method: "POST",
        headers: { ...auth, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      expect([path_, res.status]).toEqual([path_, 400]);
      const envelope = (await res.json()) as Envelope & {
        details?: { issues?: Array<{ path: string }> };
      };
      expect(envelope).toMatchObject({ error: "invalid_request", code: "invalid_request" });
      expect(envelope.details?.issues?.map((issue) => issue.path)).toContain(expected);
    }

    // Result body is a union — zod reports the failure at the root path.
    const badResult = await app.request(`/api/nodes/node-a/jobs/${jobId}/result`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ ok: false }),
    });
    expect(badResult.status).toBe(400);
    const badResultBody = (await badResult.json()) as Envelope & {
      details?: { issues?: unknown[] };
    };
    expect(badResultBody).toMatchObject({ error: "invalid_request", code: "invalid_request" });
    expect((badResultBody.details?.issues ?? []).length).toBeGreaterThan(0);
  });

  it("gates session node-job routes on 403 and keeps job_not_found codes", async () => {
    config.nodeToken = "envelope-node-token";
    const app = createApp(db, config);
    await expectForbidden(app, playerCookie, [
      ["/api/nodes/node-a/jobs", { method: "POST" }],
      ["/api/nodes/node-a/jobs/job-1", {}],
    ]);

    const missing = await app.request("/api/nodes/node-a/jobs/missing", {
      headers: { cookie },
    });
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({
      error: "job_not_found",
      code: "job_not_found",
    });

    const badResult = await app.request("/api/nodes/node-a/jobs/missing/result", {
      method: "POST",
      headers: {
        authorization: "Bearer envelope-node-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({ ok: true, result: {} }),
    });
    expect(badResult.status).toBe(404);
    expect(await badResult.json()).toEqual({
      error: "job_not_found",
      code: "job_not_found",
    });

    const badKind = await app.request("/api/nodes/node-a/jobs", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ kind: "not-a-job" }),
    });
    expect(badKind.status).toBe(400);
    const envelope = (await badKind.json()) as Envelope & {
      details?: { issues?: Array<{ path: string }> };
    };
    expect(envelope).toMatchObject({ error: "invalid_request", code: "invalid_request" });
    expect(envelope.details?.issues?.map((issue) => issue.path)).toContain("kind");
  });

  it("gates /mcp on the shared 401 unauthorized envelope", async () => {
    const app = createApp(db, config);
    const unauthorized = { error: "unauthorized", code: "unauthorized" };

    const anon = await app.request("/mcp", { method: "POST" });
    expect(anon.status).toBe(401);
    expect(await anon.json()).toEqual(unauthorized);

    const badBearer = await app.request("/mcp", {
      method: "POST",
      headers: { authorization: "Bearer playon_not-a-real-token" },
    });
    expect(badBearer.status).toBe(401);
    expect(await badBearer.json()).toEqual(unauthorized);
  });

});
