import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import type { LiveBridge } from "./bridge.js"

const instancePath = z
  .string()
  .min(1)
  .max(4_096)
  .describe('Canonical instance path beginning with "game" or "workspace"')

const listInstancesInput = z.object({
  path: instancePath.default("game").describe("Parent instance to list children of"),
  scope: z
    .enum(["children", "all", "nil"])
    .default("children")
    .describe("children of path, all instances, or unparented instances"),
  query: z.string().max(200).optional().describe("Case-insensitive name/path filter"),
  className: z.string().min(1).max(100).optional().describe("Exact ClassName filter"),
  limit: z.number().int().min(1).max(1_000).default(200),
})

const listScriptsInput = z.object({
  query: z.string().max(200).optional().describe("Case-insensitive path/name filter"),
  scope: z
    .enum(["all", "running", "loaded", "cached"])
    .default("all")
    .describe("Which live-client script inventory to inspect"),
  limit: z.number().int().min(1).max(1_000).default(200),
})

const readSourceInput = z.object({
  path: instancePath,
  startLine: z.number().int().min(1).default(1),
  lineCount: z.number().int().min(1).max(5_000).default(1_000),
})

const evalInput = z.object({
  code: z.string().min(1).max(100_000).describe("Luau chunk to execute in the live client"),
  chunkName: z.string().min(1).max(100).default("roblox-client-mcp"),
})

function textResult(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
  }
}

export function createMcpServer(bridge: LiveBridge): McpServer {
  const server = new McpServer({
    name: "roblox-client-mcp",
    version: "0.1.1",
  })

  server.registerTool(
    "roblox_list_instances",
    {
      title: "List live Roblox instances",
      description:
        "List live instances. Default lists children of a DataModel path. scope=all uses getinstances plus getnilinstances, else GetDescendants. scope=nil uses getnilinstances.",
      inputSchema: listInstancesInput,
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async (input, extra) =>
      textResult(
        await bridge.request(
          "listInstances",
          {
            path: input.path,
            scope: input.scope,
            query: input.query ?? "",
            className: input.className ?? "",
            limit: input.limit,
          },
          undefined,
          extra.signal,
        ),
      ),
  )

  server.registerTool(
    "roblox_list_scripts",
    {
      title: "List live Roblox scripts",
      description:
        "List client-visible scripts. Uses getscripts when present, else filters instances. getrunningscripts / getloadedmodules are scopes. Every getter is pcall'd.",
      inputSchema: listScriptsInput,
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async (input, extra) =>
      textResult(
        await bridge.request(
          "listScripts",
          {
            query: input.query ?? "",
            scope: input.scope,
            limit: input.limit,
          },
          undefined,
          extra.signal,
        ),
      ),
  )

  server.registerTool(
    "roblox_read_source",
    {
      title: "Read live Roblox script source",
      description:
        "Read one script path. pcall decompile when present (not UNC/sUNC); else getscriptbytecode; else constants. Returns { kind: luau|bytecode|constants|empty, data }.",
      inputSchema: readSourceInput,
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async (input, extra) =>
      textResult(
        await bridge.request(
          "readSource",
          {
            path: input.path,
            startLine: input.startLine,
            lineCount: input.lineCount,
          },
          120_000,
          extra.signal,
        ),
      ),
  )

  server.registerTool(
    "roblox_eval",
    {
      title: "Evaluate Luau in the live Roblox client",
      description:
        "Execute an explicit Luau chunk in the live client and return its JSON-safe returned values.",
      inputSchema: evalInput,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (input, extra) =>
      textResult(
        await bridge.request(
          "eval",
          { code: input.code, chunkName: input.chunkName },
          120_000,
          extra.signal,
        ),
      ),
  )

  return server
}
