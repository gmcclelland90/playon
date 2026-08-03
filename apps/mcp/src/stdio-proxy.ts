#!/usr/bin/env node
/**
 * Stdio MCP bridge for clients that cannot speak remote Streamable HTTP.
 * Proxies tools/list + tools/call to a PlayOn control plane `/mcp` endpoint.
 *
 * Usage:
 *   playon-mcp --url http://127.0.0.1:8787/mcp --token playon_…
 *   PLAYON_MCP_URL=… PLAYON_MCP_TOKEN=… playon-mcp
 */
import { Client } from "@modelcontextprotocol/client";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";

function argValue(flag: string): string | undefined {
  const idx = process.argv.indexOf(flag);
  if (idx >= 0 && process.argv[idx + 1]) return process.argv[idx + 1];
  return undefined;
}

function jsonSchemaAsStandard(parameters: Record<string, unknown>) {
  const schema =
    parameters && typeof parameters === "object" ? parameters : { type: "object", properties: {} };
  return {
    "~standard": {
      version: 1 as const,
      vendor: "playon",
      validate(value: unknown) {
        if (value === undefined || value === null) return { value: {} };
        if (typeof value !== "object" || Array.isArray(value)) {
          return { issues: [{ message: "arguments must be an object" }] };
        }
        return { value: value as Record<string, unknown> };
      },
      jsonSchema: {
        input: () => schema,
        output: () => ({ type: "object" as const }),
      },
    },
  };
}

async function main() {
  const url = argValue("--url") || process.env.PLAYON_MCP_URL?.trim();
  const token = argValue("--token") || process.env.PLAYON_MCP_TOKEN?.trim();
  if (!url || !token) {
    console.error(
      "Usage: playon-mcp --url http://host:port/mcp --token playon_…\n" +
        "Or set PLAYON_MCP_URL and PLAYON_MCP_TOKEN.",
    );
    process.exit(1);
  }

  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    },
  });

  const remote = new Client({ name: "playon-mcp-bridge", version: "0.1.0" });
  await remote.connect(transport);

  const listed = await remote.listTools();
  const local = new McpServer({ name: "playon", version: "0.1.0" });

  for (const tool of listed.tools) {
    const inputSchema =
      tool.inputSchema && typeof tool.inputSchema === "object"
        ? (tool.inputSchema as Record<string, unknown>)
        : { type: "object", properties: {} };

    local.registerTool(
      tool.name,
      {
        description: tool.description ?? tool.name,
        inputSchema: jsonSchemaAsStandard(inputSchema),
        annotations: tool.annotations,
      },
      async (args) => {
        const result = await remote.callTool({
          name: tool.name,
          arguments: (args ?? {}) as Record<string, unknown>,
        });
        return result as {
          content: Array<{ type: "text"; text: string }>;
          isError?: boolean;
        };
      },
    );
  }

  const stdio = new StdioServerTransport();
  await local.connect(stdio);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
