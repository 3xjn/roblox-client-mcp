import { afterEach, expect, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  formatStartupNotice,
  generateToken,
  loaderSnippet,
  resolveToken,
  tokenFilePath,
} from "../src/token.js"

const temps: string[] = []
const repoRoot = import.meta.dir.replace(/[\\/]tests$/, "")

afterEach(async () => {
  await Promise.all(
    temps.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  )
})

async function tempDir(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix))
  temps.push(directory)
  return directory
}

function isolatedEnv(overrides: Record<string, string> = {}): Record<string, string> {
  const environment: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && key !== "ROBLOX_CLIENT_MCP_TOKEN") {
      environment[key] = value
    }
  }
  const merged = { ...environment, ...overrides }
  if ("XDG_CONFIG_HOME" in overrides && !("LOCALAPPDATA" in overrides)) {
    delete merged["LOCALAPPDATA"]
  }
  return merged
}

async function getUnusedPort(): Promise<number> {
  const reservation = Bun.serve({ port: 0, fetch: () => new Response("reserved") })
  const port = reservation.port
  await reservation.stop(true)
  if (port === undefined) {
    throw new Error("Bun did not allocate a port")
  }
  return port
}

async function startOnce(env: Record<string, string>): Promise<{ stderr: string; stdout: string }> {
  const port = await getUnusedPort()
  const httpPort = await getUnusedPort()
  const proc = Bun.spawn({
    cmd: [process.execPath, "run", "src/index.ts"],
    cwd: repoRoot,
    env: {
      ...env,
      ROBLOX_CLIENT_MCP_PORT: String(port),
      ROBLOX_CLIENT_MCP_HTTP_PORT: String(httpPort),
    },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  })
  const stdoutChunks: Uint8Array[] = []
  const stderrChunks: Uint8Array[] = []
  let stderrText = ""

  const stdoutTask = (async () => {
    const reader = proc.stdout.getReader()
    while (true) {
      const { done, value } = await reader.read()
      if (done || value === undefined) {
        break
      }
      stdoutChunks.push(value)
    }
  })()

  const stderrTask = (async () => {
    const reader = proc.stderr.getReader()
    while (true) {
      const { done, value } = await reader.read()
      if (done || value === undefined) {
        break
      }
      stderrChunks.push(value)
      stderrText = Buffer.concat(stderrChunks).toString("utf8")
      if (stderrText.includes('loadstring(readfile("agent.lua")')) {
        proc.kill()
        break
      }
    }
  })()

  const timeout = Bun.sleep(8_000).then(() => {
    proc.kill()
    throw new Error(`Timed out waiting for loader snippet\n${stderrText}`)
  })
  await Promise.race([stderrTask, timeout])
  proc.kill()
  await proc.exited
  await Promise.race([stdoutTask, Bun.sleep(200)])
  return {
    stderr: stderrText,
    stdout: Buffer.concat(stdoutChunks).toString("utf8"),
  }
}

function tokenFromNotice(stderr: string): string {
  const match = stderr.match(/Token = "([^"]+)"/)
  const token = match?.[1]
  if (token === undefined) {
    throw new Error(`No Lua token in stderr:\n${stderr}`)
  }
  return token
}

test("tokenFilePath uses LOCALAPPDATA on Windows and XDG elsewhere", () => {
  expect(
    tokenFilePath({
      platform: "win32",
      env: { LOCALAPPDATA: join("C:", "Users", "you", "AppData", "Local") },
    }),
  ).toBe(join("C:", "Users", "you", "AppData", "Local", "roblox-client-mcp", "token"))
  expect(tokenFilePath({ platform: "linux", env: { XDG_CONFIG_HOME: "/xdg" } })).toBe(
    join("/xdg", "roblox-client-mcp", "token"),
  )
  expect(tokenFilePath({ platform: "linux", env: { HOME: "/home/you" } })).toBe(
    join("/home/you", ".config", "roblox-client-mcp", "token"),
  )
})

test("tokenFilePath falls back to cwd when no config home exists", async () => {
  const cwd = await tempDir("roblox-client-mcp-cwd-")
  expect(tokenFilePath({ platform: "linux", env: {}, cwd })).toBe(
    join(cwd, "roblox-client-mcp", "token"),
  )
})

test("first start with no env creates a token file; second start reuses it", async () => {
  const config = await tempDir("roblox-client-mcp-token-")
  const env = { XDG_CONFIG_HOME: config }
  const first = await resolveToken({ env, platform: "linux" })
  expect(first.source).toBe("file")
  if (first.source !== "file") {
    throw new Error("expected a persisted token")
  }
  expect(first.created).toBe(true)
  expect(first.token).toMatch(/^[0-9a-f]{64}$/)
  expect((await readFile(first.path, "utf8")).trim()).toBe(first.token)

  const second = await resolveToken({ env, platform: "linux" })
  expect(second).toEqual({ token: first.token, source: "file", path: first.path, created: false })
})

test("env overrides a stored token and does not rewrite the file", async () => {
  const config = await tempDir("roblox-client-mcp-override-")
  const env = { XDG_CONFIG_HOME: config }
  const stored = await resolveToken({ env, platform: "linux" })
  const override = `env-${"a".repeat(32)}`
  const resolved = await resolveToken({
    env: { ...env, ROBLOX_CLIENT_MCP_TOKEN: override },
    platform: "linux",
  })
  expect(resolved).toEqual({ token: override, source: "env" })
  if (stored.source !== "file") {
    throw new Error("expected a persisted token")
  }
  expect((await readFile(stored.path, "utf8")).trim()).toBe(stored.token)
})

test("cwd fallback creates a token file on first start", async () => {
  const cwd = await tempDir("roblox-client-mcp-cwd-token-")
  const first = await resolveToken({ env: {}, cwd, platform: "linux" })
  expect(first.source).toBe("file")
  if (first.source !== "file") {
    throw new Error("expected a persisted token")
  }
  expect(first.path).toBe(join(cwd, "roblox-client-mcp", "token"))
  expect((await readFile(first.path, "utf8")).trim()).toBe(first.token)
})

test("startup prints the loader snippet to stderr and never the token on stdout", async () => {
  const config = await tempDir("roblox-client-mcp-start-")
  const env = isolatedEnv({
    XDG_CONFIG_HOME: config,
  })

  const first = await startOnce(env)
  const token = tokenFromNotice(first.stderr)
  expect(token).toMatch(/^[0-9a-f]{64}$/)
  expect(first.stderr).toContain(loaderSnippet(token))
  expect(first.stderr).toContain(join(config, "roblox-client-mcp", "token"))
  expect(first.stdout).not.toContain(token)
  expect((await readFile(join(config, "roblox-client-mcp", "token"), "utf8")).trim()).toBe(token)

  const second = await startOnce(env)
  expect(tokenFromNotice(second.stderr)).toBe(token)
  expect(second.stdout).not.toContain(token)

  const override = `ovr-${generateToken()}`
  const third = await startOnce({ ...env, ROBLOX_CLIENT_MCP_TOKEN: override })
  expect(tokenFromNotice(third.stderr)).toBe(override)
  expect(third.stderr).toContain("from ROBLOX_CLIENT_MCP_TOKEN")
  expect(third.stdout).not.toContain(override)
  expect(third.stdout).not.toContain(token)
  expect((await readFile(join(config, "roblox-client-mcp", "token"), "utf8")).trim()).toBe(token)
})

test("startup notice includes the Lua snippet and storage location", () => {
  const notice = formatStartupNotice({
    token: "a".repeat(32),
    source: "file",
    path: "/tmp/roblox-client-mcp/token",
    created: true,
  })
  expect(notice).toContain(`token: ${"a".repeat(32)}`)
  expect(notice).toContain("stored at /tmp/roblox-client-mcp/token (created)")
  expect(notice).toContain(loaderSnippet("a".repeat(32)))
})

test("startup fails when HTTP port equals the live client port", async () => {
  const port = await getUnusedPort()
  const proc = Bun.spawn({
    cmd: [process.execPath, "run", "src/index.ts"],
    cwd: repoRoot,
    env: isolatedEnv({
      ROBLOX_CLIENT_MCP_TOKEN: "a".repeat(32),
      ROBLOX_CLIENT_MCP_PORT: String(port),
      ROBLOX_CLIENT_MCP_HTTP_PORT: String(port),
    }),
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  })
  const stderr = await new Response(proc.stderr).text()
  await proc.exited
  expect(proc.exitCode).not.toBe(0)
  expect(stderr).toContain("ROBLOX_CLIENT_MCP_HTTP_PORT must differ from ROBLOX_CLIENT_MCP_PORT")
})
