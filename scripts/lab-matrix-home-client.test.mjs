#!/usr/bin/env node
/**
 * Lab matrix Home client: MCP-only Windows placement and protect list.
 * Run: node scripts/lab-matrix-home-client.test.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  HomeClient,
  SESSION_TTL_MS,
  cachedSessionVerdict,
  classifyPlacementFailure,
  defaultPlayonContainerName,
  explainWindowsPlacementNote,
  loadHomeAuth,
  windowsPlacementConfig,
} from "./lab-matrix-home-client.mjs";

const ENV_KEYS = [
  "PLAYON_MATRIX_HOME_TOKEN",
  "PLAYON_MATRIX_HOME_SESSION",
  "PLAYON_MATRIX_WIN_NODE_ID",
  "PLAYON_MATRIX_HOME_API",
  "PLAYON_MATRIX_WIN_HOST",
  "PLAYON_MATRIX_HOME_DB",
];
const savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

function clearEnv() {
  for (const key of ENV_KEYS) delete process.env[key];
}

function restoreEnv() {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] == null) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
}

function jsonResponse(body, { status = 200, headers = {} } = {}) {
  return new Response(body == null ? "" : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function toolResult(payload, { isError = false } = {}) {
  return jsonResponse({
    jsonrpc: "2.0",
    id: 1,
    result: {
      content: [{ type: "text", text: JSON.stringify(payload) }],
      structuredContent: payload,
      isError,
    },
  });
}

function nodeBoard(status = "online", id = "playon-win-1") {
  return {
    localComputeEnabled: true,
    wireguardTools: false,
    nodeTokenConfigured: true,
    nodes: [{ id, name: id, os: "windows", status }],
  };
}

/**
 * @param {(entry: { url: string, pathname: string, method?: string, headers?: Record<string, string>, body?: any }) => Response | Promise<Response>} respond
 */
function createFetch(respond) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const entry = {
      url: String(url),
      pathname: new URL(String(url)).pathname,
      method: init?.method,
      headers: init?.headers,
      body: init?.body ? JSON.parse(init.body) : undefined,
    };
    calls.push(entry);
    return respond(entry);
  };
  return { calls, fetchImpl };
}

function mcpOk(entry, tools) {
  const method = entry.body?.method;
  if (method === "initialize" || method === "notifications/initialized") {
    return jsonResponse(
      { jsonrpc: "2.0", id: entry.body.id, result: { protocolVersion: "2024-11-05" } },
      { headers: { "mcp-session-id": "mcp-1" } },
    );
  }
  if (method === "tools/call") {
    const name = entry.body.params?.name;
    if (!Object.hasOwn(tools, name)) {
      return toolResult({ error: `unknown_tool: ${name}` }, { isError: true });
    }
    return tools[name](entry);
  }
  return jsonResponse({ error: "unexpected" }, { status: 500 });
}

function auth(extra = {}) {
  return {
    token: "playon_test",
    session: "",
    api: "http://home.test",
    winNodeId: "playon-win-1",
    winHost: "172.16.0.94",
    ...extra,
  };
}

function cfg(authPath) {
  return {
    enabled: true,
    api: "http://home.test",
    winNodeId: "playon-win-1",
    winHost: "172.16.0.94",
    authPath,
    durableDb: "/no/such/playon.db",
  };
}

clearEnv();

try {
  assert.equal(defaultPlayonContainerName("nzl"), "playon-nzl");
  assert.equal(cachedSessionVerdict({ session: "" }), "absent");
  assert.equal(
    cachedSessionVerdict({
      session: "abc",
      sessionExpiresAt: "2099-01-01T00:00:00.000Z",
    }),
    "fresh",
  );
  assert.equal(
    cachedSessionVerdict(
      { session: "abc", sessionExpiresAt: "2020-01-01T00:00:00.000Z" },
      Date.parse("2026-11-18T00:00:00Z"),
    ),
    "expired",
  );
  assert.equal(
    cachedSessionVerdict(
      { session: "abc", mintedAt: new Date(Date.now() - 86_400_000).toISOString() },
    ),
    "fresh",
  );
  assert.equal(
    cachedSessionVerdict({
      session: "abc",
      mintedAt: new Date(Date.now() - SESSION_TTL_MS - 1000).toISOString(),
    }),
    "expired",
  );
  assert.equal(cachedSessionVerdict({ session: "abc" }), "unknown");

  assert.equal(
    classifyPlacementFailure("home_rest_403: /api/nodes forbidden"),
    "auth_failed",
  );
  assert.equal(
    classifyPlacementFailure("auth_failed: MCP initialize HTTP 401 unauthorized"),
    "auth_failed",
  );
  assert.equal(
    classifyPlacementFailure("windows_node_offline: playon-win-1 status=offline"),
    "windows_node_offline",
  );
  assert.equal(
    classifyPlacementFailure("windows_node_missing: playon-win-1 is not registered on Home"),
    "windows_node_missing",
  );
  assert.equal(classifyPlacementFailure("nodes_list returned no nodes array"), "check_failed");

  process.env.PLAYON_MATRIX_WIN_NODE_ID = "off";
  assert.equal(windowsPlacementConfig("/tmp").enabled, false);
  const disabled = explainWindowsPlacementNote("disabled_by_env", "playon-win-1");
  assert.match(disabled, /disabled_by_env/);
  assert.match(disabled, /PLAYON_MATRIX_WIN_NODE_ID=off/);
  assert.doesNotMatch(disabled, /not online/);
  delete process.env.PLAYON_MATRIX_WIN_NODE_ID;
  assert.equal(windowsPlacementConfig("/tmp").enabled, true);
  assert.equal(windowsPlacementConfig("/tmp").winNodeId, "playon-win-1");

  const authNote = explainWindowsPlacementNote("unavailable:auth_failed: HTTP 403");
  assert.match(authNote, /auth_failed/);
  assert.doesNotMatch(authNote, /not online/);
  assert.match(
    explainWindowsPlacementNote("unavailable:windows_node_offline: playon-win-1 status=offline"),
    /not online/,
  );
  assert.match(
    explainWindowsPlacementNote("unavailable:windows_node_missing: playon-win-1"),
    /not registered/,
  );

  {
    const home = new HomeClient(auth({ token: "", session: "" }), {
      fetchImpl: async () => {
        throw new Error("network must not run with no credentials");
      },
    });
    await assert.rejects(() => home.requireWinNodeOnline("playon-win-1"), (err) => {
      assert.match(err.message, /^auth_failed:/);
      assert.match(err.message, /PLAYON_MATRIX_HOME_TOKEN/);
      assert.equal(classifyPlacementFailure(err.message), "auth_failed");
      return true;
    });
    await assert.rejects(() => home.loadProtectedContainerNames(), /protect_list_unavailable/);
  }

  {
    const { calls, fetchImpl } = createFetch((entry) => {
      if (entry.pathname !== "/mcp") {
        throw new Error(`REST must not be called for MCP-only placement: ${entry.pathname}`);
      }
      return mcpOk(entry, {
        nodes_list: () => toolResult(nodeBoard("online")),
      });
    });
    const home = new HomeClient(auth(), { fetchImpl });
    const node = await home.requireWinNodeOnline("playon-win-1");
    assert.equal(node.status, "online");
    assert.ok(calls.some((c) => c.body?.params?.name === "nodes_list"));
    const mcpCall = calls.find((c) => c.pathname === "/mcp");
    assert.equal(mcpCall.headers.Authorization, "Bearer playon_test");
    assert.equal(mcpCall.headers.Cookie, undefined);
    assert.ok(calls.every((c) => c.pathname === "/mcp"));
  }

  {
    const { fetchImpl } = createFetch((entry) =>
      mcpOk(entry, { nodes_list: () => toolResult(nodeBoard("stale")) }),
    );
    const home = new HomeClient(auth(), { fetchImpl });
    const node = await home.requireWinNodeOnline("playon-win-1");
    assert.equal(node.status, "stale");
  }

  {
    const { fetchImpl } = createFetch((entry) =>
      mcpOk(entry, { nodes_list: () => toolResult(nodeBoard("offline")) }),
    );
    const home = new HomeClient(auth(), { fetchImpl });
    await assert.rejects(
      () => home.requireWinNodeOnline("playon-win-1"),
      /windows_node_offline: playon-win-1 status=offline/,
    );
  }

  {
    const { fetchImpl } = createFetch((entry) =>
      mcpOk(entry, { nodes_list: () => toolResult(nodeBoard("online", "other-node")) }),
    );
    const home = new HomeClient(auth(), { fetchImpl });
    await assert.rejects(
      () => home.requireWinNodeOnline("playon-win-1"),
      /windows_node_missing: playon-win-1 is not registered on Home/,
    );
  }

  {
    const { calls, fetchImpl } = createFetch((entry) => {
      if (entry.pathname === "/mcp") {
        return jsonResponse({ error: "unauthorized", code: "unauthorized" }, { status: 401 });
      }
      throw new Error(`REST must not run after MCP auth failure without a cookie: ${entry.pathname}`);
    });
    const home = new HomeClient(auth(), { fetchImpl });
    await assert.rejects(() => home.requireWinNodeOnline("playon-win-1"), (err) => {
      assert.match(err.message, /^auth_failed:/);
      assert.equal(classifyPlacementFailure(err.message), "auth_failed");
      assert.doesNotMatch(err.message, /windows_node_offline/);
      return true;
    });
    assert.ok(calls.every((c) => c.pathname === "/mcp"));
  }

  {
    const { calls, fetchImpl } = createFetch((entry) => {
      if (entry.pathname === "/mcp") {
        return mcpOk(entry, {
          nodes_list: () => toolResult({ error: "unknown_tool: nodes_list" }, { isError: true }),
        });
      }
      if (entry.pathname === "/api/nodes") {
        assert.match(entry.headers.Cookie, /playon_session=live-cookie/);
        assert.equal(entry.headers.Authorization, undefined);
        return jsonResponse(nodeBoard("online"));
      }
      throw new Error(`unexpected ${entry.pathname}`);
    });
    const home = new HomeClient(auth({ session: "live-cookie" }), { fetchImpl });
    const node = await home.requireWinNodeOnline("playon-win-1");
    assert.equal(node.status, "online");
    assert.ok(calls.some((c) => c.pathname === "/api/nodes"));
  }

  {
    const { calls, fetchImpl } = createFetch((entry) => {
      if (entry.pathname === "/mcp") throw new Error("MCP must not run without a token");
      if (entry.pathname === "/api/nodes") {
        assert.match(entry.headers.Cookie, /playon_session=live-cookie/);
        return jsonResponse(nodeBoard("online"));
      }
      throw new Error(`unexpected ${entry.pathname}`);
    });
    const home = new HomeClient(auth({ token: "", session: "live-cookie" }), { fetchImpl });
    const node = await home.requireWinNodeOnline("playon-win-1");
    assert.equal(node.id, "playon-win-1");
    assert.ok(calls.every((c) => c.pathname === "/api/nodes"));
  }

  {
    const { fetchImpl } = createFetch((entry) => {
      if (entry.pathname === "/api/nodes") {
        return jsonResponse({ error: "forbidden", code: "forbidden" }, { status: 403 });
      }
      throw new Error(`unexpected ${entry.pathname}`);
    });
    const home = new HomeClient(auth({ token: "", session: "stale-cookie" }), { fetchImpl });
    await assert.rejects(() => home.requireWinNodeOnline("playon-win-1"), (err) => {
      assert.match(err.message, /^auth_failed:/);
      assert.match(err.message, /bearer token/i);
      assert.equal(classifyPlacementFailure(err.message), "auth_failed");
      return true;
    });
  }

  {
    const { calls, fetchImpl } = createFetch((entry) => {
      if (entry.pathname !== "/mcp") {
        throw new Error(`REST must not be called for MCP protect list: ${entry.pathname}`);
      }
      return mcpOk(entry, {
        servers_list: () =>
          toolResult([
            { id: "nzl", name: "NZL" },
            { id: "hub", name: "Hub" },
            { id: "", name: "blank" },
            { name: "no-id" },
          ]),
      });
    });
    const home = new HomeClient(auth(), { fetchImpl });
    const names = await home.loadProtectedContainerNames();
    assert.deepEqual([...names].sort(), ["playon-hub", "playon-nzl"]);
    assert.ok(calls.every((c) => c.pathname === "/mcp"));
  }

  {
    const sse = `event: message\ndata: ${JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      result: {
        content: [{ type: "text", text: "[]" }],
        structuredContent: { result: [{ id: "nzl" }] },
        isError: false,
      },
    })}\n\n`;
    const { fetchImpl } = createFetch((entry) => {
      const method = entry.body?.method;
      if (method === "initialize" || method === "notifications/initialized") {
        return jsonResponse({
          jsonrpc: "2.0",
          id: entry.body.id,
          result: { protocolVersion: "2024-11-05" },
        });
      }
      return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
    });
    const home = new HomeClient(auth(), { fetchImpl });
    const names = await home.loadProtectedContainerNames();
    assert.deepEqual([...names], ["playon-nzl"]);
  }

  {
    const { fetchImpl } = createFetch((entry) =>
      mcpOk(entry, { servers_list: () => toolResult([]) }),
    );
    const home = new HomeClient(auth(), { fetchImpl });
    const names = await home.loadProtectedContainerNames();
    assert.equal(names.size, 0);
  }

  {
    const { calls, fetchImpl } = createFetch((entry) => {
      if (entry.pathname === "/mcp") {
        return jsonResponse({ error: "unauthorized", code: "unauthorized" }, { status: 401 });
      }
      throw new Error(`must not assume an empty protect list via ${entry.pathname}`);
    });
    const home = new HomeClient(auth(), { fetchImpl });
    await assert.rejects(() => home.loadProtectedContainerNames(), (err) => {
      assert.match(err.message, /protect_list_unavailable/);
      assert.match(err.message, /fail closed/);
      assert.match(err.message, /auth_failed/);
      return true;
    });
    assert.ok(calls.every((c) => c.pathname === "/mcp"));
  }

  {
    const { calls, fetchImpl } = createFetch((entry) => {
      if (entry.pathname === "/mcp") {
        return mcpOk(entry, {
          servers_list: () => toolResult({ error: "unknown_tool: servers_list" }, { isError: true }),
        });
      }
      if (entry.pathname === "/api/servers") {
        assert.match(entry.headers.Cookie, /playon_session=live-cookie/);
        return jsonResponse({ servers: [{ id: "hub" }] });
      }
      throw new Error(`unexpected ${entry.pathname}`);
    });
    const home = new HomeClient(auth({ session: "live-cookie" }), { fetchImpl });
    const names = await home.loadProtectedContainerNames();
    assert.deepEqual([...names], ["playon-hub"]);
    assert.ok(calls.some((c) => c.pathname === "/api/servers"));
  }

  {
    const { fetchImpl } = createFetch((entry) => {
      if (entry.pathname === "/api/servers") {
        return jsonResponse({ error: "forbidden", code: "forbidden" }, { status: 403 });
      }
      throw new Error(`unexpected ${entry.pathname}`);
    });
    const home = new HomeClient(auth({ token: "", session: "stale-cookie" }), { fetchImpl });
    await assert.rejects(() => home.loadProtectedContainerNames(), (err) => {
      assert.match(err.message, /protect_list_unavailable/);
      assert.match(err.message, /fail closed/);
      assert.doesNotMatch(err.message, /playon-$/);
      return true;
    });
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "playon-matrix-auth-"));
  const authPath = path.join(dir, "auth.json");
  const homeCfg = cfg(authPath);

  {
    fs.writeFileSync(
      authPath,
      JSON.stringify({
        token: "playon_cached",
        session: "stale-session",
        sessionExpiresAt: "2020-01-01T00:00:00.000Z",
        mintedAt: "2020-01-01T00:00:00.000Z",
      }),
    );
    let fetched = false;
    const loaded = await loadHomeAuth(homeCfg, {
      now: Date.parse("2026-11-18T00:00:00Z"),
      fetchImpl: async () => {
        fetched = true;
        return jsonResponse({ user: { id: "owner" } });
      },
    });
    assert.equal(fetched, false);
    assert.equal(loaded.token, "playon_cached");
    assert.equal(loaded.session, "");
  }

  {
    fs.writeFileSync(
      authPath,
      JSON.stringify({
        token: "playon_cached",
        session: "still-good",
        mintedAt: new Date(Date.parse("2026-11-18T00:00:00Z") - 86_400_000).toISOString(),
      }),
    );
    let fetched = false;
    const loaded = await loadHomeAuth(homeCfg, {
      now: Date.parse("2026-11-18T00:00:00Z"),
      fetchImpl: async () => {
        fetched = true;
        return jsonResponse({}, { status: 401 });
      },
    });
    assert.equal(fetched, false);
    assert.equal(loaded.session, "still-good");
  }

  {
    fs.writeFileSync(
      authPath,
      JSON.stringify({
        token: "playon_cached",
        session: "maybe",
      }),
    );
    const dropped = await loadHomeAuth(homeCfg, {
      fetchImpl: async (url) => {
        assert.match(String(url), /\/api\/auth\/me$/);
        return jsonResponse({ error: "unauthorized" }, { status: 401 });
      },
    });
    assert.equal(dropped.token, "playon_cached");
    assert.equal(dropped.session, "");

    const kept = await loadHomeAuth(homeCfg, {
      fetchImpl: async () => jsonResponse({ user: { id: "owner" } }),
    });
    assert.equal(kept.session, "maybe");
  }

  {
    process.env.PLAYON_MATRIX_HOME_TOKEN = "playon_env";
    delete process.env.PLAYON_MATRIX_HOME_SESSION;
    fs.writeFileSync(
      authPath,
      JSON.stringify({ token: "playon_file", session: "file-session", sessionExpiresAt: "2099-01-01T00:00:00.000Z" }),
    );
    let fetched = false;
    const loaded = await loadHomeAuth(homeCfg, {
      fetchImpl: async () => {
        fetched = true;
        return jsonResponse({ user: {} });
      },
    });
    assert.equal(fetched, false);
    assert.equal(loaded.token, "playon_env");
    assert.equal(loaded.session, "");
  }

  {
    process.env.PLAYON_MATRIX_HOME_TOKEN = "playon_env";
    process.env.PLAYON_MATRIX_HOME_SESSION = "env-session";
    const dropped = await loadHomeAuth(homeCfg, {
      fetchImpl: async (url, init) => {
        assert.match(String(url), /\/api\/auth\/me$/);
        assert.match(init.headers.Cookie, /playon_session=env-session/);
        return jsonResponse({ error: "unauthorized" }, { status: 401 });
      },
    });
    assert.equal(dropped.token, "playon_env");
    assert.equal(dropped.session, "");

    const kept = await loadHomeAuth(homeCfg, {
      fetchImpl: async () => jsonResponse({ user: { id: "owner" } }),
    });
    assert.equal(kept.session, "env-session");
    delete process.env.PLAYON_MATRIX_HOME_TOKEN;
    delete process.env.PLAYON_MATRIX_HOME_SESSION;
  }

  fs.rmSync(dir, { recursive: true, force: true });
  console.log("lab-matrix-home-client.test.mjs ok");
} finally {
  restoreEnv();
}
