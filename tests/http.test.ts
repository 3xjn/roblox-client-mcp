import { afterEach, expect, test } from "bun:test"
import type { LiveBridge } from "../src/bridge.js"
import { HTTP_MCP_PATH, startHttpServer } from "../src/http.js"
import type { RequestMethod } from "../src/protocol.js"

const TOKEN = "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789"

const requests: Array<{ method: RequestMethod; params: Readonly<Record<string, unknown>> }> = []
const servers: Array<{ stop(): Promise<void> }> = []

const bridge: LiveBridge = {
  port: 0,
  async request(method, params) {
    requests.push({ method, params })
    return { values: [1], count: 1, returned: 1, truncated: false }
  },
  status() {
    return { connected: false }
  },
  async stop() {},
}

afterEach(async () => {
  requests.splice(0)
  await Promise.all(servers.splice(0).map((server) => server.stop()))
})

async function getUnusedPort(): Promise<number> {
  const reservation = Bun.serve({ port: 0, fetch: () => new Response("reserved") })
  const port = reservation.port
  await reservation.stop(true)
  if (port === undefined) {
    throw new Error("Bun did not allocate a port")
  }
  return port
}

async function startOnUnusedPort() {
  const port = await getUnusedPort()
  const server = startHttpServer({ bridge, token: TOKEN, port })
  servers.push(server)
  return server
}

function mcpUrl(port: number): string {
  return `http://127.0.0.1:${port}${HTTP_MCP_PATH}`
}

async function rpc(
  port: number,
  body: Record<string, unknown>,
  token = TOKEN,
  sessionId?: string,
): Promise<{ status: number; parsed: unknown; sessionId: string | null }> {
  const headers: Record<string, string> = {
    accept: "application/json, text/event-stream",
    "content-type": "application/json",
    authorization: `Bearer ${token}`,
  }
  if (sessionId !== undefined) {
    headers["mcp-session-id"] = sessionId
  }
  const response = await fetch(mcpUrl(port), {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  })
  const text = await response.text()
  let parsed: unknown = text
  try {
    parsed = text.length === 0 ? null : JSON.parse(text)
  } catch {
    parsed = text
  }
  return { status: response.status, parsed, sessionId: response.headers.get("mcp-session-id") }
}

test("HTTP MCP rejects missing and wrong Bearer tokens", async () => {
  const server = await startOnUnusedPort()
  const unauthorized = await fetch(mcpUrl(server.port), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
  })
  expect(unauthorized.status).toBe(401)
  expect(unauthorized.headers.get("www-authenticate")).toBe("Bearer")

  const wrong = await fetch(mcpUrl(server.port), {
    method: "POST",
    headers: {
      authorization: "Bearer not-the-bridge-token-not-the-bridge-token-not",
      "content-type": "application/json",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
  })
  expect(wrong.status).toBe(401)
})

test("HTTP MCP initializes and lists the eight tools", async () => {
  const server = await startOnUnusedPort()
  const init = await rpc(server.port, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "http-test", version: "0.1.0" },
    },
  })
  expect(init.status).toBe(200)
  expect(init.sessionId).toBeTruthy()
  const sessionId = init.sessionId ?? undefined
  await rpc(server.port, { jsonrpc: "2.0", method: "notifications/initialized" }, TOKEN, sessionId)
  const listed = await rpc(
    server.port,
    { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
    TOKEN,
    sessionId,
  )
  expect(listed.status).toBe(200)
  const names = (
    (listed.parsed as { result?: { tools?: Array<{ name: string }> } }).result?.tools ?? []
  ).map((tool) => tool.name)
  expect(names.sort()).toEqual([
    "roblox_eval",
    "roblox_inspect",
    "roblox_list_instances",
    "roblox_list_scripts",
    "roblox_read_source",
    "roblox_search_source",
    "roblox_status",
    "roblox_validate",
  ])
})

test("HTTP MCP tools/call relays to the live bridge", async () => {
  const server = await startOnUnusedPort()
  const init = await rpc(server.port, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "http-test", version: "0.1.0" },
    },
  })
  const sessionId = init.sessionId ?? undefined
  await rpc(server.port, { jsonrpc: "2.0", method: "notifications/initialized" }, TOKEN, sessionId)
  const called = await rpc(
    server.port,
    {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "roblox_eval", arguments: { code: "return 1", chunkName: "http-test" } },
    },
    TOKEN,
    sessionId,
  )
  expect(called.status).toBe(200)
  expect(requests).toEqual([
    { method: "eval", params: { code: "return 1", chunkName: "http-test" } },
  ])
})
