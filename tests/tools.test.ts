import { afterEach, expect, test } from "bun:test"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import type { LiveBridge } from "../src/bridge.js"
import { BridgeUnavailableError } from "../src/errors.js"
import type { RequestMethod } from "../src/protocol.js"
import { createMcpServer } from "../src/tools.js"

const requests: Array<{ method: RequestMethod; params: Readonly<Record<string, unknown>> }> = []
const clients: Client[] = []
const listing = {
  total: 0,
  returned: 0,
  scope: "all",
  query: "",
  coverage: { complete: true, scanned: 0, limitReached: false, sources: [] },
}
let response: unknown = { ...listing, scripts: [] }
let failure: Error | undefined
const bridge: LiveBridge = {
  port: 0,
  async request(method, params) {
    requests.push({ method, params })
    if (failure) throw failure
    return response
  },
  status() {
    return { connected: false }
  },
  async stop() {},
}
async function openClient() {
  const [ct, st] = InMemoryTransport.createLinkedPair()
  const server = createMcpServer(bridge)
  const client = new Client({ name: "test", version: "1" })
  await Promise.all([server.connect(st), client.connect(ct)])
  clients.push(client)
  return client
}
afterEach(async () => {
  requests.length = 0
  failure = undefined
  response = { ...listing, scripts: [] }
  await Promise.all(clients.splice(0).map((c) => c.close()))
})
test("advertises schemas for all eight tools", async () => {
  const c = await openClient()
  const { tools } = await c.listTools()
  expect(tools).toHaveLength(8)
  for (const tool of tools) expect(tool.outputSchema).toBeDefined()
  expect(c.getServerVersion()?.version).toBe("0.2.0")
})
test("status avoids a live round trip", async () => {
  const c = await openClient()
  const r = await c.callTool({ name: "roblox_status", arguments: {} })
  expect(r.structuredContent).toEqual({ connected: false })
  expect(requests).toHaveLength(0)
})
test("global discovery does not inject game root and returns checked structured content", async () => {
  const c = await openClient()
  const r = await c.callTool({ name: "roblox_list_scripts", arguments: { scope: "all" } })
  expect(requests[0]).toEqual({
    method: "listScripts",
    params: { scope: "all", query: "", limit: 50 },
  })
  expect(r.structuredContent).toEqual(response)
  expect(r.isError).not.toBe(true)
})
test("forwards exact refs and bounded source defaults", async () => {
  const c = await openClient()
  response = {
    ref: "session:1",
    path: "<nil>[Script]",
    className: "LocalScript",
    kind: "unavailable",
    provenance: "none",
    cache: "miss",
    failures: [],
  }
  const r = await c.callTool({ name: "roblox_read_source", arguments: { ref: "session:1" } })
  expect(r.isError).not.toBe(true)
  expect(requests[0]?.params).toMatchObject({
    ref: "session:1",
    lineCount: 100,
    representation: "source",
    refresh: false,
  })
  expect(requests[0]?.params).not.toHaveProperty("path")
})
test("invalid response is an actionable MCP tool error", async () => {
  const c = await openClient()
  response = { nonsense: true }
  const r = await c.callTool({ name: "roblox_list_scripts", arguments: {} })
  expect(r.isError).toBe(true)
  expect(r.structuredContent).toBeUndefined()
})
test("bridge errors use MCP error signaling", async () => {
  const c = await openClient()
  failure = new BridgeUnavailableError()
  const r = await c.callTool({ name: "roblox_eval", arguments: { code: "return 1" } })
  expect(r.isError).toBe(true)
  expect(JSON.stringify(r.content)).toContain("disconnected")
})
test("compile-only tool forwards separately from eval", async () => {
  const c = await openClient()
  response = { valid: false, diagnostic: { code: "compile", message: "unexpected token" } }
  const r = await c.callTool({ name: "roblox_validate", arguments: { code: "return )" } })
  expect(r.structuredContent).toEqual(response)
  expect(requests[0]?.method).toBe("validate")
})

test("explicit source-search candidates do not inject a conflicting scope", async () => {
  const client = await openClient()
  response = {
    matches: [],
    mode: "expand",
    query: "needle",
    coverage: {
      complete: true,
      searched: 1,
      candidates: 1,
      remaining: 0,
      unavailable: 0,
      inventory: { complete: true },
      matchLimitReached: false,
    },
  }
  const result = await client.callTool({
    name: "roblox_search_source",
    arguments: { refs: ["session:1"], query: "needle", mode: "expand" },
  })
  expect(result.isError).not.toBe(true)
  expect(requests[0]?.params).not.toHaveProperty("scope")
})
