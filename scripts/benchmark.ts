import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import type { LiveBridge } from "../src/bridge"
import { createMcpServer } from "../src/tools"
import { createFixture, plain } from "../tests/lua-fixture"

// Deterministic prescribed workflows, not an autonomous model benchmark.
const tasks = [
  {
    name: "generic-script-evidence",
    code: `local result = call("searchSource", {query="target_behavior",mode="expand",maxScripts=20})
      assert(#result.matches == 1 and result.matches[1].line == 2)
      local source = call("readSource", {ref=result.matches[1].ref,startLine=2,lineCount=1})
      assert(source.data:find("target_behavior") and source.provenance == "decompiled")`,
  },
  {
    name: "duplicate-exact-target",
    code: `local rows = call("listScripts", {query="Duplicate"}).scripts
      assert(#rows == 2 and rows[1].ref ~= rows[2].ref)
      local selected
      for _, row in ipairs(rows) do
        local source = call("readSource", {ref=row.ref})
        if source.data:find("99") then selected = row end
      end
      assert(selected)
      assert(call("inspect", {ref=selected.ref,properties={"Name"}}).ref == selected.ref)`,
  },
  {
    name: "unparented-script",
    code: `local row = call("listScripts", {query="Detached"}).scripts[1]
      assert(call("readSource", {ref=row.ref}).data:find("orphan%-evidence"))
      local inspected = call("inspect", {ref=row.ref,properties={"Parent"}})
      assert(inspected.properties.Parent.value.type == "nil")`,
  },
  {
    name: "unavailable-evidence",
    setup: "env.getrunningscripts=nil; env.decompile=nil",
    code: `local page = call("listScripts", {scope="running"})
      assert(#page.scripts == 0 and not page.coverage.complete and page.coverage.sources[1].status == "unavailable")
      local row = call("listScripts", {query="Script"}).scripts[1]
      assert(call("readSource", {ref=row.ref}).kind == "unavailable")
      assert(not call("searchSource", {query="absent",mode="cached"}).coverage.complete)`,
  },
  {
    name: "compile-execute-assert",
    code: `local code = "local function double(n) return n * 2 end; assert(double(21) == 42); return double(21)"
      assert(call("validate", {code=code}).valid)
      local result = call("eval", {code=code})
      assert(result.count == 1 and result.values[1] == 42)`,
  },
  {
    name: "repair-runtime-failure",
    code: `local failure = call("eval", {code="local value=nil; return value.total"}, true)
      assert(failure.code == "runtime" and #failure.details > 0)
      retries = 1
      local repaired = "local value={total=42}; assert(value.total == 42); return value.total"
      assert(call("validate", {code=repaired}).valid)
      assert(call("eval", {code=repaired}).values[1] == 42)`,
  },
]

const results = []
for (const task of tasks) {
  const fixture = await createFixture(task.setup)
  const start = performance.now()
  try {
    const [metrics] = await fixture.run(`
      local calls, bytes, evals = 0, 0, 0
      local retries = 0
      local function call(method, params, expectFailure)
        calls += 1
        if method == "eval" then evals += 1 end
        local ok, result = pcall(agent.handlers[method], params)
        bytes += #hostJson(result)
        assert(ok ~= (expectFailure == true))
        return result
      end
      ${task.code}
      return {success=true, correctTargetAndEvidence=true, handlerCalls=calls,
        evals=evals, unnecessaryEvals=0, retries=retries, returnedBytes=bytes}
    `)
    results.push({
      task: task.name,
      ...(plain(metrics) as object),
      elapsedMs: +(performance.now() - start).toFixed(3),
      tokens: null,
    })
  } finally {
    fixture.close()
  }
}
const mcpSamples = []
for (const sample of [
  {
    name: "recovered-source",
    tool: "roblox_read_source",
    prepare: `local ref = agent.handlers.listScripts({query="Script"}).scripts[1].ref
      return hostJson(agent.handlers.readSource({ref=ref})), hostJson({ref=ref})`,
  },
  {
    name: "nested-eval",
    tool: "roblox_eval",
    prepare: `local code = "return {name='fixture', settings={speed=12,enabled=true}, values={1,2,3}},nil"
      return hostJson(agent.handlers.eval({code=code})), hostJson({code=code})`,
  },
]) {
  const fixture = await createFixture()
  const [resultJson, argumentsJson] = await fixture.run(sample.prepare)
  const value: unknown = JSON.parse(String(resultJson))
  const args = JSON.parse(String(argumentsJson)) as Record<string, unknown>
  const bridge: LiveBridge = {
    port: 0,
    async request() {
      return value
    },
    status() {
      return { connected: false }
    },
    async stop() {},
  }
  const server = createMcpServer(bridge)
  const client = new Client({ name: "response-cost-benchmark", version: "1" })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  try {
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
    const start = performance.now()
    const response = await client.callTool({ name: sample.tool, arguments: args })
    if (response.isError) throw new Error(`Unexpected MCP error in ${sample.name}`)
    const content = response.content as Array<{ type: string; text?: string }>
    const textBytes = content.reduce(
      (sum, item) => sum + (item.type === "text" ? Buffer.byteLength(item.text ?? "") : 0),
      0,
    )
    const structuredBytes = Buffer.byteLength(JSON.stringify(response.structuredContent))
    mcpSamples.push({
      sample: sample.name,
      handlerJsonBytes: Buffer.byteLength(String(resultJson)),
      textBytes,
      structuredContentJsonBytes: structuredBytes,
      combinedContentBytes: textBytes + structuredBytes,
      wholeCallToolResultJsonBytes: Buffer.byteLength(JSON.stringify(response)),
      elapsedMs: +(performance.now() - start).toFixed(3),
      tokens: null,
    })
  } finally {
    await client.close()
    await server.close()
    fixture.close()
  }
}

console.log(
  JSON.stringify(
    {
      kind: "offline-prescribed-handler-workflows",
      runtime: `Bun ${Bun.version}; luau-web 1.5.1`,
      handlerWorkflowExcludes:
        "model inference, MCP wrapping/transport bytes, Roblox/executor integration; elapsed excludes fixture initialization",
      results,
      mcpSamples,
      mcpSampleScope:
        "Actual createMcpServer + SDK InMemoryTransport; excludes JSON-RPC envelope, model inference/tokens, and Roblox transport. combinedContentBytes counts text plus structured JSON if both are supplied to a model.",
    },
    null,
    2,
  ),
)
