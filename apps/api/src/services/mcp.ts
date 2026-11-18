import { eq } from "drizzle-orm";
import {
  createMcpHandler,
  McpServer,
  type AuthInfo,
} from "@modelcontextprotocol/server";
import { RoleSchema } from "@playon/shared";
import type { ControlPlane } from "../control-plane.js";
import { users } from "../db/schema.js";
import type { AccessTokenPrincipal } from "./access-tokens.js";
import { jsonSchemaAsStandard } from "./mcp-json-schema.js";
import { runWithToolActor, type ToolActor } from "./tool-actor.js";
import { createPlayOnToolRegistry, type PlayOnToolRegistry } from "./tools.js";

function resultIsError(result: unknown): boolean {
  if (!result || typeof result !== "object") return false;
  const row = result as { error?: unknown; online?: unknown };
  // LiveServerState uses `error` for offline detail; that is not a tool failure.
  if (typeof row.online === "boolean") return false;
  return typeof row.error === "string" && row.error.length > 0;
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
            : { readOnlyHint: Boolean(def.readOnly) },
        },
        async (args) => {
          const result = await invokeRegisteredMcpTool(
            plane,
            principal,
            registry,
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

type McpInvokeOptions = {
  confirmPolicy: "auto" | "gate";
  autoApproveActor?: string;
};

/**
 * Run one registry tool as the MCP token's user.
 * `nodes_list` reads this actor and refuses roles below operator.
 */
export async function invokeRegisteredMcpTool(
  plane: ControlPlane,
  principal: AccessTokenPrincipal | null,
  registry: PlayOnToolRegistry,
  name: string,
  args: Record<string, unknown>,
  invokeOptions: McpInvokeOptions,
): Promise<unknown> {
  const actor = await resolveMcpToolActor(plane, principal);
  const run = () => registry.invoke(name, args, invokeOptions);
  return actor ? runWithToolActor(actor, run) : run();
}

async function resolveMcpToolActor(
  plane: ControlPlane,
  principal: AccessTokenPrincipal | null,
): Promise<ToolActor | undefined> {
  if (!principal) return undefined;
  if (!principal.userId) return { userId: "", role: null };
  const rows = await plane.db
    .select({ role: users.role })
    .from(users)
    .where(eq(users.id, principal.userId))
    .limit(1);
  const parsed = RoleSchema.safeParse(rows[0]?.role);
  return { userId: principal.userId, role: parsed.success ? parsed.data : null };
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
