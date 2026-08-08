import {
  createMcpHandler,
  McpServer,
  type AuthInfo,
} from "@modelcontextprotocol/server";
import type { ControlPlane } from "../control-plane.js";
import type { AccessTokenPrincipal } from "./access-tokens.js";
import { jsonSchemaAsStandard } from "./mcp-json-schema.js";
import { createPlayOnToolRegistry } from "./tools.js";

function resultIsError(result: unknown): boolean {
  if (!result || typeof result !== "object") return false;
  const err = (result as { error?: unknown }).error;
  return typeof err === "string" && err.length > 0;
}

/** Build a per-request MCP server exposing the shared PlayOn tool registry. */
export function createPlayOnMcpHandler(plane: ControlPlane) {
  return createMcpHandler(({ authInfo }) => {
    const principal = authInfoToPrincipal(authInfo);
    const confirmPolicy = principal?.autoApproveConfirms ? "auto" : "gate";
    const { registry } = createPlayOnToolRegistry(plane, {
      confirmGate: plane.confirm,
    });

    const server = new McpServer({
      name: "playon",
      version: "0.1.0",
    });

    for (const def of registry.getDefinitions()) {
      server.registerTool(
        def.name,
        {
          description: def.description,
          inputSchema: jsonSchemaAsStandard(def.parameters),
          annotations: def.requiresConfirm
            ? { destructiveHint: true, readOnlyHint: false }
            : { readOnlyHint: false },
        },
        async (args) => {
          const result = await registry.invoke(
            def.name,
            (args ?? {}) as Record<string, unknown>,
            {
              confirmPolicy,
              autoApproveActor: principal ? `token:${principal.id}` : undefined,
            },
          );
          const text = JSON.stringify(result ?? null);
          return {
            content: [{ type: "text" as const, text }],
            structuredContent:
              result && typeof result === "object"
                ? (result as Record<string, unknown>)
                : { value: result },
            isError: resultIsError(result),
          };
        },
      );
    }

    return server;
  });
}

export function authInfoFromAccessToken(
  token: string,
  principal: AccessTokenPrincipal,
): AuthInfo {
  return {
    token,
    clientId: principal.id,
    scopes: ["playon.tools"],
    // Non-expiring PATs: far-future expiry so SDK helpers that require expiresAt stay happy.
    expiresAt: Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 365 * 10,
    extra: {
      userId: principal.userId,
      autoApproveConfirms: principal.autoApproveConfirms,
      name: principal.name,
    },
  };
}

function authInfoToPrincipal(authInfo: AuthInfo | undefined): AccessTokenPrincipal | null {
  if (!authInfo?.clientId) return null;
  return {
    id: authInfo.clientId,
    name: typeof authInfo.extra?.name === "string" ? authInfo.extra.name : "mcp",
    userId: typeof authInfo.extra?.userId === "string" ? authInfo.extra.userId : "",
    autoApproveConfirms: Boolean(authInfo.extra?.autoApproveConfirms),
  };
}
