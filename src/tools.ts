import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import type { LiveBridge } from "./bridge.js"
import { outputSchemas, resultSchemas, statusResultSchema } from "./protocol.js"

const locator = {
  ref: z
    .string()
    .min(1)
    .max(256)
    .optional()
    .describe(
      "Exact diagnostic reference from this live agent; expires on replacement or eviction. Never embed in persistent scripts.",
    ),
  path: z
    .string()
    .min(1)
    .max(4096)
    .optional()
    .describe("Optional unambiguous game/workspace path; duplicate sibling names fail."),
}
const page = {
  cursor: z
    .string()
    .min(1)
    .max(256)
    .optional()
    .describe("Continue the same snapshot; expires after 60 seconds."),
  limit: z.number().int().min(1).max(200).default(50),
}
const listInstancesInput = z.object({
  ...locator,
  ...page,
  scope: z.enum(["children", "all", "nil"]).default("children"),
  query: z.string().max(200).default(""),
  className: z.string().max(100).default(""),
})
const listScriptsInput = z.object({
  ...page,
  scope: z.enum(["all", "running", "loaded", "cached"]).default("all"),
  query: z.string().max(200).default(""),
})
const readSourceInput = z.object({
  ...locator,
  startLine: z.number().int().min(1).default(1),
  startColumn: z.number().int().min(1).max(262145).default(1),
  lineCount: z.number().int().min(1).max(500).default(100),
  refresh: z.boolean().default(false),
  representation: z.enum(["source", "bytecode"]).default("source"),
  byteOffset: z.number().int().min(1).max(262145).default(1),
  byteCount: z.number().int().min(1).max(4096).default(1024),
})
const searchInput = z.object({
  query: z.string().min(1).max(256).optional(),
  mode: z.enum(["cached", "expand"]).default("cached"),
  refs: z.array(z.string().min(1).max(256)).max(5000).optional(),
  scope: z.enum(["all", "running", "loaded", "cached"]).optional(),
  cursor: z.string().min(1).max(256).optional(),
  maxScripts: z.number().int().min(1).max(20).default(5),
  limit: z.number().int().min(1).max(50).default(20),
})
const inspectInput = z.object({
  ...locator,
  properties: z.array(z.string().min(1).max(128)).min(1).max(20).default(["Name", "Parent"]),
  attributes: z.boolean().default(false),
  tags: z.boolean().default(false),
  ancestry: z.boolean().default(false),
})
const codeInput = z.object({
  code: z.string().min(1).max(100000),
  chunkName: z.string().min(1).max(100).default("roblox-client-mcp"),
})

function toolError(error: unknown) {
  const record = error instanceof Error ? error : new Error(String(error))
  const code =
    "code" in record && typeof record.code === "string" ? record.code : "invalid_response"
  const details =
    "traceback" in record && typeof record.traceback === "string"
      ? record.traceback.slice(0, 4096)
      : undefined
  return {
    isError: true,
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({
          code,
          message: record.message.slice(0, 4096),
          ...(details ? { details } : {}),
        }),
      },
    ],
  }
}
function result(value: Record<string, unknown>) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
    structuredContent: value,
  }
}

export function createMcpServer(bridge: LiveBridge): McpServer {
  const server = new McpServer({ name: "roblox-client-mcp", version: "0.2.0" })
  server.registerTool(
    "roblox_status",
    {
      title: "Live client status",
      description:
        "Check connection, live-agent identity, capabilities and limits without a client round trip. Capability presence permits an attempt; it does not promise success.",
      inputSchema: z.object({}),
      outputSchema: statusResultSchema,
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async () => result(statusResultSchema.parse(bridge.status())),
  )
  const definitions = [
    {
      name: "roblox_list_instances",
      method: "listInstances",
      input: listInstancesInput,
      description:
        "Find exact live targets. children defaults to game children; all without a root inspects global client-visible inventory, nil requires getnilinstances. Explicit root filters descendants. Name matches rank ahead of path matches. Read coverage and continue nextCursor; paths are descriptions and refs expire.",
    },
    {
      name: "roblox_list_scripts",
      method: "listScripts",
      input: listScriptsInput,
      description:
        "Find scripts by ranked literal name/path match. running, loaded and cached use only their named getters. Unavailable or failed inventories never imply absence. Continue nextCursor within the fixed snapshot.",
    },
    {
      name: "roblox_read_source",
      method: "readSource",
      input: readSourceInput,
      description:
        "Read evidence for an exact ref (or unambiguous path). Decompiled Luau is labeled; constants are evidence, not source or proof of behavior. Continue using startLine=nextLine and startColumn=nextColumn (or 1 when absent); refresh retries cached weak results. Bytecode requires explicit representation=bytecode and uses byteOffset pages.",
    },
    {
      name: "roblox_search_source",
      method: "searchSource",
      input: searchInput,
      description:
        "Search a literal string or identifier in recovered evidence. cached searches only cache; expand recovers at most maxScripts from explicit refs or a scope per call. Zero matches with partial coverage is inconclusive. Continue nextCursor. Only decompiled matches have source line numbers; constants do not prove behavior.",
    },
    {
      name: "roblox_inspect",
      method: "inspect",
      input: inspectInput,
      description:
        "Inspect selected properties, attributes, tags and ancestry of one exact target. Field failures are explicit; values and depth are bounded. Does not execute modules to infer interfaces.",
    },
    {
      name: "roblox_validate",
      method: "validate",
      input: codeInput,
      description:
        "Compile Luau without invoking the chunk. valid=true establishes syntax validity only. It does not verify runtime API contracts or requested behavior.",
    },
    {
      name: "roblox_eval",
      method: "eval",
      input: codeInput,
      description:
        "Execute a Luau chunk. Completion covers the submitted chunk, not later callbacks. Verify requested behavior with a relevant observation/assertion. Preserves nil positions and return count; bounded values may truncate. Cancellation is best effort and never rollback.",
    },
  ] as const
  for (const definition of definitions) {
    const schema = resultSchemas[definition.method]
    server.registerTool(
      definition.name,
      {
        title: definition.name.replaceAll("_", " "),
        description: definition.description,
        inputSchema: definition.input,
        outputSchema: outputSchemas[definition.method],
        annotations: {
          readOnlyHint: definition.method !== "eval",
          destructiveHint: definition.method === "eval",
          idempotentHint: false,
          openWorldHint: true,
        },
      },
      async (input: Record<string, unknown>, extra: { signal: AbortSignal }) => {
        try {
          const value = await bridge.request(
            definition.method,
            input,
            definition.method === "readSource" ||
              definition.method === "searchSource" ||
              definition.method === "eval"
              ? 120000
              : 30000,
            extra.signal,
          )
          return result(schema.parse(value))
        } catch (error) {
          return toolError(error)
        }
      },
    )
  }
  return server
}
