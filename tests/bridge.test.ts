import { afterEach, describe, expect, spyOn, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  BRIDGE_PATH,
  type LiveBridge,
  MAX_PENDING_REQUESTS,
  POLL_PATH,
  startBridge,
} from "../src/bridge.js"
import {
  AgentRequestError,
  BridgeBusyError,
  BridgeTimeoutError,
  BridgeUnavailableError,
} from "../src/errors.js"
import { type AgentInfo, requestMessageSchema, responseMessageSchema } from "../src/protocol.js"

const TOKEN = "0123456789abcdef0123456789abcdef"
const AGENT: AgentInfo = {
  agentVersion: "test",
  sessionId: "test-session",
  capabilities: {},
  limits: {},
  placeId: 123,
  jobId: "job",
  playerName: "Builder",
  userId: 456,
}

let bridge: LiveBridge | undefined
let socket: WebSocket | undefined

class TestHarnessError extends Error {
  readonly name = "TestHarnessError"
}

function waitForOpen(client: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    client.addEventListener("open", () => resolve(), { once: true })
    client.addEventListener(
      "error",
      () => reject(new TestHarnessError("WebSocket failed to open")),
      { once: true },
    )
  })
}

function waitForMessage(client: WebSocket): Promise<unknown> {
  return new Promise((resolve, reject) => {
    client.addEventListener(
      "message",
      (event) => {
        if (typeof event.data !== "string") {
          reject(new TestHarnessError("Expected a text frame"))
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

async function openAgent(): Promise<WebSocket> {
  if (bridge === undefined) {
    throw new TestHarnessError("Bridge was not started")
  }
  const client = new WebSocket(`ws://127.0.0.1:${bridge.port}${BRIDGE_PATH}`)
  await waitForOpen(client)
  return client
}

async function waitForFileMessage(
  directory: string,
  type: string,
): Promise<{ type?: unknown; id?: unknown }> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const payload = JSON.parse(await readFile(join(directory, "to-agent.json"), "utf8")) as {
        type?: unknown
        id?: unknown
      }
      if (payload.type === type) return payload
    } catch {
      // Atomicity is not guaranteed by executor filesystem adapters.
    }
    await Bun.sleep(20)
  }
  throw new TestHarnessError(`File poll did not deliver ${type}`)
}

afterEach(async () => {
  await bridge?.stop()
  socket?.close()
  socket = undefined
  bridge = undefined
})

describe("live bridge", () => {
  test("keeps active file work alive and accepts a late unknown-cancel acknowledgement", async () => {
    const directory = await mkdtemp(join(tmpdir(), "roblox-client-mcp-file-lifecycle-"))
    const realNow = Date.now.bind(Date)
    let clock: ReturnType<typeof spyOn> | undefined
    try {
      bridge = startBridge({ token: TOKEN, port: 0, filePollDir: directory })
      await writeFile(
        join(directory, "to-host.json"),
        JSON.stringify({ type: "hello", token: TOKEN, agent: AGENT }),
      )
      await waitForFileMessage(directory, "ready")
      const controller = new AbortController()
      const active = bridge
        .request("eval", {}, 5000, controller.signal)
        .catch((error: unknown) => error)
      const request = await waitForFileMessage(directory, "request")
      clock = spyOn(Date, "now").mockImplementation(() => realNow() + 16000)
      expect(bridge.status().connected).toBe(true)
      controller.abort()
      expect(await active).toMatchObject({ code: "cancelled" })
      expect(bridge.status().connected).toBe(false)
      const cancellation = await waitForFileMessage(directory, "cancel")
      expect(cancellation.id).toBe(request.id)
      // The executor may have seen only the cancellation if it overwrote an
      // unread request. Its unknown-cancel acknowledgement releases the slot.
      await writeFile(
        join(directory, "to-host.json"),
        JSON.stringify({
          type: "response",
          token: TOKEN,
          sessionId: AGENT.sessionId,
          id: request.id,
          ok: false,
          error: { code: "cancelled", message: "No active request" },
        }),
      )
      for (let attempt = 0; attempt < 100 && !bridge.status().connected; attempt += 1)
        await Bun.sleep(20)
      expect(bridge.status().connected).toBe(true)
      const next = bridge.request("listScripts", {}).catch((error: unknown) => error)
      const nextRequest = await waitForFileMessage(directory, "request")
      expect(nextRequest.id).not.toBe(request.id)
      await bridge.stop()
      await next
    } finally {
      clock?.mockRestore()
      await bridge?.stop()
      await rm(directory, { recursive: true, force: true })
    }
  })

  test("aborts queued work without dispatching it and cancels active work", async () => {
    bridge = startBridge({ token: TOKEN, port: 0 })
    const endpoint = `http://127.0.0.1:${bridge.port}${POLL_PATH}`
    const post = (body: unknown) => fetch(endpoint, { method: "POST", body: JSON.stringify(body) })
    await post({ type: "hello", token: TOKEN, agent: AGENT })
    const activeController = new AbortController()
    const active = bridge
      .request("eval", {}, 5000, activeController.signal)
      .catch((error: unknown) => error)
    const request = requestMessageSchema.parse(
      await (await post({ type: "poll", token: TOKEN, sessionId: AGENT.sessionId })).json(),
    )
    const queuedController = new AbortController()
    const queued = bridge
      .request("listScripts", {}, 5000, queuedController.signal)
      .catch((error: unknown) => error)
    queuedController.abort()
    expect(await queued).toMatchObject({ code: "cancelled" })
    activeController.abort()
    expect(await active).toMatchObject({ code: "cancelled" })
    expect(
      await (await post({ type: "poll", token: TOKEN, sessionId: AGENT.sessionId })).json(),
    ).toEqual({ type: "cancel", id: request.id, sessionId: AGENT.sessionId })
    await post({
      type: "response",
      token: TOKEN,
      sessionId: AGENT.sessionId,
      id: request.id,
      ok: false,
      error: { code: "cancelled", message: "Cancelled" },
    })
    const next = bridge.request("listScripts", {}).catch((error: unknown) => error)
    const nextRequest = requestMessageSchema.parse(
      await (await post({ type: "poll", token: TOKEN, sessionId: AGENT.sessionId })).json(),
    )
    expect(nextRequest.id).not.toBe(request.id)
    await bridge.stop()
    await next
  })

  test("bounds and serializes dispatched work, retaining the slot after a caller timeout", async () => {
    bridge = startBridge({ token: TOKEN, port: 0 })
    socket = await openAgent()
    const ready = waitForMessage(socket)
    socket.send(JSON.stringify({ type: "hello", token: TOKEN, agent: AGENT }))
    await ready
    const received: unknown[] = []
    socket.addEventListener("message", (event) => received.push(JSON.parse(String(event.data))))
    const firstReceived = waitForMessage(socket)
    const first = bridge.request("eval", { source: "task.wait(1)" }, 200)
    const firstFailure = expect(first).rejects.toBeInstanceOf(BridgeTimeoutError)
    await firstReceived
    const others = Array.from({ length: MAX_PENDING_REQUESTS - 1 }, () =>
      bridge?.request("listScripts", {}, 5000).catch((error: unknown) => error),
    )
    await expect(bridge.request("listScripts", {})).rejects.toBeInstanceOf(BridgeBusyError)
    await firstFailure
    expect(received.filter((value) => (value as { type: string }).type === "request")).toHaveLength(
      1,
    )
    await expect(bridge.request("listScripts", {})).rejects.toBeInstanceOf(BridgeBusyError)
    const request = requestMessageSchema.parse(received[0])
    socket.send(
      JSON.stringify({
        type: "response",
        id: request.id,
        sessionId: AGENT.sessionId,
        ok: true,
        result: null,
      }),
    )
    await Bun.sleep(20)
    expect(received.filter((value) => (value as { type: string }).type === "request")).toHaveLength(
      2,
    )
    await bridge.stop()
    await Promise.all(others)
  })

  test("preserves structured runtime error details", async () => {
    bridge = startBridge({ token: TOKEN, port: 0 })
    socket = await openAgent()
    const ready = waitForMessage(socket)
    socket.send(JSON.stringify({ type: "hello", token: TOKEN, agent: AGENT }))
    await ready
    const received = waitForMessage(socket)
    const result = bridge
      .request("eval", { source: "error('broken')" })
      .catch((error: unknown) => error)
    const request = requestMessageSchema.parse(await received)
    socket.send(
      JSON.stringify({
        type: "response",
        sessionId: AGENT.sessionId,
        id: request.id,
        ok: false,
        error: { code: "runtime", message: "broken", details: "stack trace" },
      }),
    )
    const error = await result
    expect(error).toBeInstanceOf(AgentRequestError)
    expect(error).toMatchObject({ code: "runtime", message: "broken", traceback: "stack trace" })
  })

  test("rejects replaced HTTP sessions and discards requests that expire before polling", async () => {
    bridge = startBridge({ token: TOKEN, port: 0 })
    const endpoint = `http://127.0.0.1:${bridge.port}${POLL_PATH}`
    const post = (body: unknown) => fetch(endpoint, { method: "POST", body: JSON.stringify(body) })
    await post({ type: "hello", token: TOKEN, agent: AGENT })
    await expect(bridge.request("eval", {}, 10)).rejects.toBeInstanceOf(BridgeTimeoutError)
    const next = bridge.request("listScripts", {})
    const request = requestMessageSchema.parse(
      await (await post({ type: "poll", token: TOKEN, sessionId: AGENT.sessionId })).json(),
    )
    expect(request.method).toBe("listScripts")
    const done = next.catch((error: unknown) => error)
    await post({ type: "hello", token: TOKEN, agent: { ...AGENT, sessionId: "replacement" } })
    expect((await post({ type: "poll", token: TOKEN, sessionId: AGENT.sessionId })).status).toBe(
      401,
    )
    expect(
      (
        await post({
          type: "response",
          token: TOKEN,
          sessionId: AGENT.sessionId,
          id: request.id,
          ok: true,
          result: null,
        })
      ).status,
    ).toBe(401)
    await done
  })

  test("rejects requests without an authenticated live client", async () => {
    bridge = startBridge({ token: TOKEN, port: 0 })
    expect(bridge.status()).toEqual({ connected: false })
    await expect(bridge.request("listScripts", {})).rejects.toBeInstanceOf(BridgeUnavailableError)
  })

  test("authenticates an agent and correlates a response", async () => {
    bridge = startBridge({ token: TOKEN, port: 0 })
    socket = await openAgent()
    const ready = waitForMessage(socket)
    socket.send(JSON.stringify({ type: "hello", token: TOKEN, agent: AGENT }))
    expect(await ready).toEqual({ type: "ready", sessionId: AGENT.sessionId })
    expect(bridge.status()).toEqual({
      connected: true,
      agent: { ...AGENT, transport: "websocket" },
    })

    const requestReceived = waitForMessage(socket)
    const pendingResult = bridge.request("listScripts", { query: "door" })
    const request = requestMessageSchema.parse(await requestReceived)
    expect(request.method).toBe("listScripts")
    socket.send(
      JSON.stringify(
        responseMessageSchema.parse({
          type: "response",
          sessionId: AGENT.sessionId,
          id: request.id,
          ok: true,
          result: { scripts: [], total: 0, returned: 0 },
        }),
      ),
    )

    await expect(pendingResult).resolves.toEqual({ scripts: [], total: 0, returned: 0 })
  })

  test("times out a request that the agent does not answer", async () => {
    bridge = startBridge({ token: TOKEN, port: 0 })
    socket = await openAgent()
    const ready = waitForMessage(socket)
    socket.send(JSON.stringify({ type: "hello", token: TOKEN, agent: AGENT }))
    await ready
    await expect(bridge.request("listScripts", {}, 10)).rejects.toBeInstanceOf(BridgeTimeoutError)
  })

  test("does not accept an incorrect token", async () => {
    bridge = startBridge({ token: TOKEN, port: 0 })
    socket = await openAgent()
    socket.send(
      JSON.stringify({
        type: "hello",
        token: "fedcba9876543210fedcba9876543210",
        agent: AGENT,
      }),
    )
    await Bun.sleep(20)
    expect(bridge.status()).toEqual({ connected: false })
    expect(socket.readyState).not.toBe(WebSocket.OPEN)
  })

  test("authenticates over HTTP poll and correlates a response", async () => {
    bridge = startBridge({ token: TOKEN, port: 0 })
    const endpoint = `http://127.0.0.1:${bridge.port}/live/poll`
    const hello = await fetch(endpoint, {
      method: "POST",
      body: JSON.stringify({ type: "hello", token: TOKEN, agent: AGENT }),
    })
    expect(hello.status).toBe(200)
    expect(await hello.json()).toEqual({ type: "ready", sessionId: AGENT.sessionId })
    expect(bridge.status()).toMatchObject({
      connected: true,
      agent: { ...AGENT, transport: "http" },
    })

    const pendingResult = bridge.request("listScripts", { query: "door" })
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
        result: { scripts: [], total: 0, returned: 0 },
      }),
    })
    expect(await answered.json()).toEqual({ type: "ack" })
    await expect(pendingResult).resolves.toEqual({ scripts: [], total: 0, returned: 0 })
  })

  test("rejects HTTP poll with an incorrect token", async () => {
    bridge = startBridge({ token: TOKEN, port: 0 })
    const response = await fetch(`http://127.0.0.1:${bridge.port}/live/poll`, {
      method: "POST",
      body: JSON.stringify({
        type: "hello",
        token: "fedcba9876543210fedcba9876543210",
        agent: AGENT,
      }),
    })
    expect(response.status).toBe(401)
    expect(bridge.status()).toEqual({ connected: false })
  })

  test("authenticates over file poll and correlates a response", async () => {
    const directory = await mkdtemp(join(tmpdir(), "roblox-client-mcp-file-"))
    try {
      bridge = startBridge({ token: TOKEN, port: 0, filePollDir: directory })
      await writeFile(
        join(directory, "to-host.json"),
        JSON.stringify({ type: "hello", token: TOKEN, agent: AGENT }),
      )
      let ready: unknown
      for (let attempt = 0; attempt < 50; attempt += 1) {
        try {
          ready = JSON.parse(await readFile(join(directory, "to-agent.json"), "utf8"))
          break
        } catch {
          await Bun.sleep(50)
        }
      }
      expect(ready).toEqual({ type: "ready", sessionId: AGENT.sessionId })
      expect(bridge.status()).toMatchObject({
        connected: true,
        agent: { ...AGENT, transport: "file" },
      })

      const pendingResult = bridge.request("listScripts", { query: "door" })
      let request: ReturnType<typeof requestMessageSchema.parse> | undefined
      for (let attempt = 0; attempt < 50; attempt += 1) {
        const payload: unknown = JSON.parse(
          await readFile(join(directory, "to-agent.json"), "utf8"),
        )
        if (
          typeof payload === "object" &&
          payload !== null &&
          "type" in payload &&
          payload.type === "request"
        ) {
          request = requestMessageSchema.parse(payload)
          break
        }
        await Bun.sleep(50)
      }
      if (request === undefined) {
        throw new TestHarnessError("File poll did not deliver a request")
      }
      expect(request.method).toBe("listScripts")
      await writeFile(
        join(directory, "to-host.json"),
        JSON.stringify({
          type: "response",
          sessionId: AGENT.sessionId,
          token: TOKEN,
          id: request.id,
          ok: true,
          result: { scripts: [], total: 0, returned: 0 },
        }),
      )
      await expect(pendingResult).resolves.toEqual({ scripts: [], total: 0, returned: 0 })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test("returns idle on HTTP poll when no request is queued", async () => {
    bridge = startBridge({ token: TOKEN, port: 0 })
    const endpoint = `http://127.0.0.1:${bridge.port}${POLL_PATH}`
    const hello = await fetch(endpoint, {
      method: "POST",
      body: JSON.stringify({ type: "hello", token: TOKEN, agent: AGENT }),
    })
    expect(await hello.json()).toEqual({ type: "ready", sessionId: AGENT.sessionId })
    const poll = await fetch(endpoint, {
      method: "POST",
      body: JSON.stringify({ type: "poll", token: TOKEN, sessionId: AGENT.sessionId }),
    })
    expect(poll.status).toBe(200)
    expect(await poll.json()).toEqual({ type: "idle" })
  })

  test("rejects non-POST HTTP poll", async () => {
    bridge = startBridge({ token: TOKEN, port: 0 })
    const response = await fetch(`http://127.0.0.1:${bridge.port}${POLL_PATH}`)
    expect(response.status).toBe(405)
  })

  test("does not accept file poll with an incorrect token", async () => {
    const directory = await mkdtemp(join(tmpdir(), "roblox-client-mcp-file-bad-"))
    try {
      bridge = startBridge({ token: TOKEN, port: 0, filePollDir: directory })
      await writeFile(
        join(directory, "to-host.json"),
        JSON.stringify({
          type: "hello",
          token: "fedcba9876543210fedcba9876543210",
          agent: AGENT,
        }),
      )
      for (let attempt = 0; attempt < 20; attempt += 1) {
        await Bun.sleep(50)
        expect(bridge.status()).toEqual({ connected: false })
      }
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
