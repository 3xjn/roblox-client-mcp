import { timingSafeEqual } from "node:crypto"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import type { ServerWebSocket } from "bun"
import {
  AgentRequestError,
  BridgeDisconnectedError,
  BridgeStartupError,
  BridgeTimeoutError,
  BridgeUnavailableError,
} from "./errors.js"
import {
  type AgentCommand,
  type AgentInfo,
  helloMessageSchema,
  parseHttpAgentResponse,
  pollMessageSchema,
  type RequestMethod,
  responseMessageSchema,
} from "./protocol.js"

const AUTH_TIMEOUT_MS = 5_000
const MAX_PAYLOAD_BYTES = 2 * 1024 * 1024
const STOP_GRACE_MS = 100
const POLL_WAIT_MS = 2_000
const HTTP_IDLE_MS = 15_000
const FILE_POLL_MS = 100
export const BRIDGE_PATH = "/live"
export const POLL_PATH = "/live/poll"

type SocketData = {
  authenticated: boolean
}

type PendingRequest = {
  readonly resolve: (value: unknown) => void
  readonly reject: (reason: Error) => void
  readonly timeout: ReturnType<typeof setTimeout>
  readonly cleanup: () => void
}

type PollWaiter = {
  resolve(request: AgentCommand | undefined): void
  timeout: ReturnType<typeof setTimeout>
}

type ActiveSession =
  | { kind: "websocket"; socket: ServerWebSocket<SocketData>; agent: AgentInfo }
  | { kind: "http"; agent: AgentInfo; lastSeen: number }
  | { kind: "file"; agent: AgentInfo; lastSeen: number }

export type BridgeStatus = {
  readonly connected: boolean
  readonly agent?: AgentInfo
}

export interface LiveBridge {
  readonly port: number
  request(
    method: RequestMethod,
    params: Readonly<Record<string, unknown>>,
    timeoutMs?: number,
    signal?: AbortSignal,
  ): Promise<unknown>
  status(): BridgeStatus
  stop(): Promise<void>
}

export type BridgeOptions = {
  readonly token: string
  readonly port: number
  readonly requestTimeoutMs?: number
  readonly filePollDir?: string
}

function tokenMatches(actual: string, expected: string): boolean {
  const actualBytes = Buffer.from(actual)
  const expectedBytes = Buffer.from(expected)
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes)
}

function parseJson(source: string): unknown {
  try {
    return JSON.parse(source)
  } catch (error) {
    if (error instanceof SyntaxError) {
      return null
    }
    throw error
  }
}

function jsonResponse(status: number, body: unknown): Response {
  return Response.json(body, { status })
}

export function startBridge(options: BridgeOptions): LiveBridge {
  const defaultTimeoutMs = options.requestTimeoutMs ?? 30_000
  const pending = new Map<string, PendingRequest>()
  const authTimeouts = new Map<ServerWebSocket<SocketData>, ReturnType<typeof setTimeout>>()
  const outbound: AgentCommand[] = []
  const waiters: PollWaiter[] = []
  let session: ActiveSession | undefined
  let lastFilePayload = ""
  let fileTimer: ReturnType<typeof setInterval> | undefined

  function rejectPending(error: Error): void {
    for (const request of pending.values()) {
      request.cleanup()
      request.reject(error)
    }
    pending.clear()
  }

  function clearWaiters(): void {
    outbound.length = 0
    for (const waiter of waiters.splice(0)) {
      waiter.resolve(undefined)
    }
  }

  function dropSession(error = new BridgeDisconnectedError()): void {
    const current = session
    session = undefined
    rejectPending(error)
    clearWaiters()
    if (current?.kind === "websocket") {
      current.socket.close(1012, "Replaced by a newer live client")
    }
  }

  function pollSessionAlive(kind: "http" | "file"): boolean {
    return session?.kind === kind && Date.now() - session.lastSeen <= HTTP_IDLE_MS
  }

  function deliverHttp(request: AgentCommand): void {
    const waiter = waiters.shift()
    if (waiter !== undefined) {
      waiter.resolve(request)
      return
    }
    outbound.push(request)
  }

  function takeOutbound(waitMs: number): Promise<AgentCommand | undefined> {
    const queued = outbound.shift()
    if (queued !== undefined) {
      return Promise.resolve(queued)
    }
    return new Promise((resolve) => {
      const waiter: PollWaiter = {
        resolve(request) {
          clearTimeout(waiter.timeout)
          resolve(request)
        },
        timeout: setTimeout(() => {
          const index = waiters.indexOf(waiter)
          if (index !== -1) {
            waiters.splice(index, 1)
          }
          resolve(undefined)
        }, waitMs),
      }
      waiters.push(waiter)
    })
  }

  function acceptResponse(raw: unknown): boolean {
    const response = responseMessageSchema.safeParse(raw)
    if (!response.success) {
      return false
    }
    const request = pending.get(response.data.id)
    if (request === undefined) {
      return true
    }
    request.cleanup()
    pending.delete(response.data.id)
    if (response.data.ok) {
      request.resolve(response.data.result)
    } else {
      request.reject(new AgentRequestError(response.data.id, response.data.error))
    }
    return true
  }

  async function writeAgentFile(body: unknown): Promise<void> {
    const directory = options.filePollDir
    if (directory === undefined) {
      return
    }
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, "to-agent.json"), `${JSON.stringify(body)}\n`, "utf8")
  }

  async function handlePoll(request: Request): Promise<Response> {
    let raw: unknown
    try {
      raw = await request.json()
    } catch {
      return jsonResponse(400, { type: "error", error: "Invalid JSON" })
    }

    const hello = helloMessageSchema.safeParse(raw)
    if (hello.success) {
      if (!tokenMatches(hello.data.token, options.token)) {
        return jsonResponse(401, { type: "error", error: "Authentication failed" })
      }
      dropSession()
      session = {
        kind: "http",
        agent: { ...hello.data.agent, transport: "http" },
        lastSeen: Date.now(),
      }
      return jsonResponse(200, { type: "ready" })
    }

    const poll = pollMessageSchema.safeParse(raw)
    if (poll.success) {
      if (!tokenMatches(poll.data.token, options.token) || !pollSessionAlive("http")) {
        return jsonResponse(401, { type: "error", error: "Authentication failed" })
      }
      if (session?.kind === "http") {
        session.lastSeen = Date.now()
      }
      const next = await takeOutbound(POLL_WAIT_MS)
      return next === undefined ? jsonResponse(200, { type: "idle" }) : jsonResponse(200, next)
    }

    const response = parseHttpAgentResponse(raw)
    if (response !== undefined) {
      if (!tokenMatches(response.token, options.token) || !pollSessionAlive("http")) {
        return jsonResponse(401, { type: "error", error: "Authentication failed" })
      }
      if (session?.kind === "http") {
        session.lastSeen = Date.now()
      }
      if (!acceptResponse(response)) {
        return jsonResponse(400, { type: "error", error: "Invalid response" })
      }
      return jsonResponse(200, { type: "ack" })
    }

    return jsonResponse(400, { type: "error", error: "Unknown poll message" })
  }

  async function handleFilePayload(raw: unknown): Promise<void> {
    const hello = helloMessageSchema.safeParse(raw)
    if (hello.success) {
      if (!tokenMatches(hello.data.token, options.token)) {
        return
      }
      dropSession()
      session = {
        kind: "file",
        agent: { ...hello.data.agent, transport: "file" },
        lastSeen: Date.now(),
      }
      await writeAgentFile({ type: "ready" })
      return
    }

    const response = parseHttpAgentResponse(raw)
    if (response === undefined || !tokenMatches(response.token, options.token)) {
      return
    }
    if (!pollSessionAlive("file") && session?.kind !== "file") {
      return
    }
    if (session?.kind === "file") {
      session.lastSeen = Date.now()
    }
    acceptResponse(response)
  }

  if (options.filePollDir !== undefined) {
    const directory = options.filePollDir
    const toHost = join(directory, "to-host.json")
    void mkdir(directory, { recursive: true })
    fileTimer = setInterval(() => {
      void (async () => {
        let contents: string
        try {
          contents = await readFile(toHost, "utf8")
        } catch {
          return
        }
        if (contents === lastFilePayload) {
          return
        }
        lastFilePayload = contents
        const parsed = parseJson(contents)
        if (parsed !== null) {
          await handleFilePayload(parsed)
        }
      })()
    }, FILE_POLL_MS)
  }

  const server = Bun.serve<SocketData>({
    hostname: "127.0.0.1",
    port: options.port,
    fetch(request, bunServer) {
      const url = new URL(request.url)
      if (url.pathname === POLL_PATH) {
        if (request.method !== "POST") {
          return new Response("Method not allowed", { status: 405 })
        }
        return handlePoll(request)
      }
      if (url.pathname !== BRIDGE_PATH) {
        return new Response("Not found", { status: 404 })
      }
      const upgraded = bunServer.upgrade(request, { data: { authenticated: false } })
      return upgraded ? undefined : new Response("WebSocket upgrade required", { status: 426 })
    },
    websocket: {
      idleTimeout: 0,
      maxPayloadLength: MAX_PAYLOAD_BYTES,
      open(socket) {
        const timeout = setTimeout(() => {
          socket.close(1008, "Authentication timed out")
        }, AUTH_TIMEOUT_MS)
        authTimeouts.set(socket, timeout)
      },
      message(socket, message) {
        if (typeof message !== "string") {
          socket.close(1003, "Text frames only")
          return
        }

        const raw = parseJson(message)
        if (!socket.data.authenticated) {
          const hello = helloMessageSchema.safeParse(raw)
          if (!hello.success || !tokenMatches(hello.data.token, options.token)) {
            socket.close(1008, "Authentication failed")
            return
          }

          const authTimeout = authTimeouts.get(socket)
          if (authTimeout !== undefined) {
            clearTimeout(authTimeout)
            authTimeouts.delete(socket)
          }

          dropSession()
          socket.data.authenticated = true
          session = {
            kind: "websocket",
            socket,
            agent: { ...hello.data.agent, transport: "websocket" },
          }
          socket.send(JSON.stringify({ type: "ready" }))
          return
        }

        if (!acceptResponse(raw)) {
          socket.close(1007, "Invalid response")
        }
      },
      close(socket) {
        const authTimeout = authTimeouts.get(socket)
        if (authTimeout !== undefined) {
          clearTimeout(authTimeout)
          authTimeouts.delete(socket)
        }
        if (session?.kind === "websocket" && session.socket === socket) {
          session = undefined
          rejectPending(new BridgeDisconnectedError())
          clearWaiters()
        }
      },
    },
  })
  const boundPort = server.port
  if (boundPort === undefined) {
    throw new BridgeStartupError("Bun did not report the live bridge port")
  }

  return {
    port: boundPort,
    status() {
      if (session?.kind === "websocket") {
        return { connected: true, agent: session.agent }
      }
      if (pollSessionAlive("http") && session?.kind === "http") {
        return { connected: true, agent: session.agent }
      }
      if (pollSessionAlive("file") && session?.kind === "file") {
        return { connected: true, agent: session.agent }
      }
      return { connected: false }
    },
    async request(method, params, timeoutMs = defaultTimeoutMs, signal) {
      const current = session
      if (
        current === undefined ||
        (current.kind === "http" && !pollSessionAlive("http")) ||
        (current.kind === "file" && !pollSessionAlive("file"))
      ) {
        throw new BridgeUnavailableError()
      }

      signal?.throwIfAborted()
      const id = crypto.randomUUID()
      const started = Date.now()
      const log = (event: string) =>
        console.error(
          JSON.stringify({
            component: "roblox-client-mcp",
            event,
            id,
            method,
            elapsedMs: Date.now() - started,
          }),
        )
      const send = (command: AgentCommand) => {
        if (current.kind === "websocket") current.socket.send(JSON.stringify(command))
        else if (current.kind === "http") deliverHttp(command)
        else void writeAgentFile(command).catch(() => cancel("delivery-error"))
      }
      let cancel: (event: string) => void = () => {}
      log("request-start")
      try {
        return await new Promise<unknown>((resolve, reject) => {
          const cleanup = () => {
            clearTimeout(timeout)
            signal?.removeEventListener("abort", aborted)
          }
          cancel = (event) => {
            if (!pending.delete(id)) return
            cleanup()
            // Never send an old request's cancellation to a replacement session.
            if (session === current) {
              const queued = outbound.findIndex((command) => command.id === id)
              if (queued !== -1) outbound.splice(queued, 1)
              try {
                send({ type: "cancel", id })
              } catch {
                /* disconnected */
              }
            }
            log(event)
            reject(
              event === "timeout"
                ? new BridgeTimeoutError(id, timeoutMs)
                : new Error(`Request ${event}`),
            )
          }
          const aborted = () => cancel("cancelled")
          const timeout = setTimeout(() => cancel("timeout"), timeoutMs)
          pending.set(id, { resolve, reject, timeout, cleanup })
          signal?.addEventListener("abort", aborted, { once: true })
          try {
            send({ type: "request", id, method, params, timeoutMs })
          } catch {
            cancel("delivery-error")
          }
        })
      } finally {
        log("request-end")
      }
    },
    async stop() {
      if (fileTimer !== undefined) {
        clearInterval(fileTimer)
        fileTimer = undefined
      }
      dropSession()
      await Promise.race([server.stop(true), Bun.sleep(STOP_GRACE_MS)])
    },
  }
}
