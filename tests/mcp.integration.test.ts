import { expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import { z } from "zod"
import { BRIDGE_PATH, POLL_PATH } from "../src/bridge.js"
import { requestMessageSchema } from "../src/protocol.js"

const TOKEN = "abcdef0123456789abcdef0123456789"
const AGENT = {
  agentVersion: "integration",
  sessionId: "integration-session",
  capabilities: {},
  limits: {},
  placeId: 321,
  jobId: "integration-job",
  playerName: "Builder",
  userId: 654,
}
const SCRIPT_RESULT = {
  scripts: [
    {
      ref: "integration-session:1",
      childCount: 0,
      isScript: true,
      name: "DoorManager",
      className: "LocalScript",
      path: 'game:GetService("Players")["Builder"]["PlayerScripts"]["DoorManager"]',
    },
  ],
  coverage: { complete: true, scanned: 1, limitReached: false, sources: [] },
  total: 1,
  returned: 1,
  scope: "all",
  query: "door",
}

class IntegrationHarnessError extends Error {
  readonly name = "IntegrationHarnessError"
}

function waitForOpen(socket: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true })
    socket.addEventListener(
      "error",
      () => reject(new IntegrationHarnessError("Live client peer failed to connect")),
      { once: true },
    )
  })
}

function waitForMessage(socket: WebSocket): Promise<unknown> {
  return new Promise((resolve, reject) => {
    socket.addEventListener(
      "message",
      (event) => {
        if (typeof event.data !== "string") {
          reject(new IntegrationHarnessError("Expected a text frame"))
          return
        }
        try {
          resolve(JSON.parse(event.data))
        } catch (error) {
          if (error instanceof SyntaxError) {
            reject(error)
            return
          }
          throw error
        }
      },
      { once: true },
    )
  })
}

async function getUnusedPort(): Promise<number> {
  const reservation = Bun.serve({ port: 0, fetch: () => new Response("reserved") })
  const port = reservation.port
  await reservation.stop(true)
  if (port === undefined) {
    throw new IntegrationHarnessError("Bun did not allocate a port")
  }
  return port
}

function childEnvironment(
  port: number,
  extra: Record<string, string> = {},
): Record<string, string> {
  const environment: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) {
      environment[key] = value
    }
  }
  environment["ROBLOX_CLIENT_MCP_TOKEN"] = TOKEN
  environment["ROBLOX_CLIENT_MCP_PORT"] = String(port)
  return { ...environment, ...extra }
}

async function openStdioClient(
  port: number,
  extra?: Record<string, string>,
): Promise<{
  client: Client
  transport: StdioClientTransport
}> {
  const httpPort =
    extra !== undefined && extra["ROBLOX_CLIENT_MCP_HTTP_PORT"] !== undefined
      ? extra["ROBLOX_CLIENT_MCP_HTTP_PORT"]
      : String(await getUnusedPort())
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["run", "src/index.ts"],
    cwd: import.meta.dir.replace(/[\\/]tests$/, ""),
    env: childEnvironment(port, { ROBLOX_CLIENT_MCP_HTTP_PORT: httpPort, ...extra }),
    stderr: "pipe",
  })
  return { client: new Client({ name: "roblox-client-mcp-test", version: "0.1.1" }), transport }
}

async function expectDoorManager(toolResult: Promise<unknown>): Promise<void> {
  const parsed = z
    .object({
      content: z.array(z.object({ type: z.literal("text"), text: z.string() })).min(1),
    })
    .parse(await toolResult)
  expect(parsed.content[0]?.text).toContain("DoorManager")
}

async function waitForJsonFile(
  path: string,
  isMatch: (value: unknown) => boolean,
): Promise<unknown> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const value: unknown = JSON.parse(await readFile(path, "utf8"))
      if (isMatch(value)) {
        return value
      }
    } catch {
      // File has not been written yet.
    }
    await Bun.sleep(50)
  }
  throw new IntegrationHarnessError(`Timed out waiting for ${path}`)
}

test("serves a live client response through the stdio MCP transport", async () => {
  const port = await getUnusedPort()
  const { client, transport } = await openStdioClient(port)
  let socket: WebSocket | undefined

  try {
    await client.connect(transport)
    socket = new WebSocket(`ws://127.0.0.1:${port}${BRIDGE_PATH}`)
    await waitForOpen(socket)
    const ready = waitForMessage(socket)
    socket.send(JSON.stringify({ type: "hello", token: TOKEN, agent: AGENT }))
    expect(await ready).toEqual({ type: "ready", sessionId: AGENT.sessionId })

    const requestReceived = waitForMessage(socket)
    const toolResult = client.callTool({
      name: "roblox_list_scripts",
      arguments: { query: "door", scope: "all", limit: 20 },
    })
    const request = requestMessageSchema.parse(await requestReceived)
    expect(request.method).toBe("listScripts")
    socket.send(
      JSON.stringify({
        type: "response",
        sessionId: AGENT.sessionId,
        id: request.id,
        ok: true,
        result: SCRIPT_RESULT,
      }),
    )
    await expectDoorManager(toolResult)
  } finally {
    socket?.close()
    await client.close()
  }
})

test("serves a live client response over HTTP poll", async () => {
  const port = await getUnusedPort()
  const { client, transport } = await openStdioClient(port)

  try {
    await client.connect(transport)
    const endpoint = `http://127.0.0.1:${port}${POLL_PATH}`
    const hello = await fetch(endpoint, {
      method: "POST",
      body: JSON.stringify({ type: "hello", token: TOKEN, agent: AGENT }),
    })
    expect(hello.status).toBe(200)
    expect(await hello.json()).toEqual({ type: "ready", sessionId: AGENT.sessionId })

    const toolResult = client.callTool({
      name: "roblox_list_scripts",
      arguments: { query: "door", scope: "all", limit: 20 },
    })
    const poll = await fetch(endpoint, {
      method: "POST",
      body: JSON.stringify({ type: "poll", token: TOKEN, sessionId: AGENT.sessionId }),
    })
    const request = requestMessageSchema.parse(await poll.json())
    expect(request.method).toBe("listScripts")
    const answered = await fetch(endpoint, {
      method: "POST",
      body: JSON.stringify({
        type: "response",
        sessionId: AGENT.sessionId,
        token: TOKEN,
        id: request.id,
        ok: true,
        result: SCRIPT_RESULT,
      }),
    })
    expect(await answered.json()).toEqual({ type: "ack" })
    await expectDoorManager(toolResult)
  } finally {
    await client.close()
  }
})

test("serves a live client response over ROBLOX_CLIENT_MCP_FILEPOLL", async () => {
  const port = await getUnusedPort()
  const directory = await mkdtemp(join(tmpdir(), "roblox-client-mcp-filepoll-"))
  const { client, transport } = await openStdioClient(port, {
    ROBLOX_CLIENT_MCP_FILEPOLL: directory,
  })
  const toHost = join(directory, "to-host.json")
  const toAgent = join(directory, "to-agent.json")

  try {
    await client.connect(transport)
    await writeFile(toHost, JSON.stringify({ type: "hello", token: TOKEN, agent: AGENT }))
    expect(
      await waitForJsonFile(toAgent, (value) => {
        return (
          typeof value === "object" && value !== null && "type" in value && value.type === "ready"
        )
      }),
    ).toEqual({ type: "ready", sessionId: AGENT.sessionId })

    const toolResult = client.callTool({
      name: "roblox_list_scripts",
      arguments: { query: "door", scope: "all", limit: 20 },
    })
    const request = requestMessageSchema.parse(
      await waitForJsonFile(toAgent, (value) => {
        return (
          typeof value === "object" && value !== null && "type" in value && value.type === "request"
        )
      }),
    )
    expect(request.method).toBe("listScripts")
    await writeFile(
      toHost,
      JSON.stringify({
        type: "response",
        sessionId: AGENT.sessionId,
        token: TOKEN,
        id: request.id,
        ok: true,
        result: SCRIPT_RESULT,
      }),
    )
    await expectDoorManager(toolResult)
  } finally {
    await client.close()
    await rm(directory, { recursive: true, force: true })
  }
})
