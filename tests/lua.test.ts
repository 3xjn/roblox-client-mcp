import { describe, expect, test } from "bun:test"
import { resultSchemas } from "../src/protocol"
import { createFixture } from "./lua-fixture"

async function scenario(code: string, setup = "") {
  const fixture = await createFixture(setup)
  try {
    return await fixture.run(code)
  } finally {
    fixture.close()
  }
}

describe("actual agent.lua in Luau WASM", () => {
  test("websocket capability detects a connector after an absent first candidate", async () => {
    expect(
      await scenario(
        "return agent.capabilities().websocket",
        "env.WebSocket=nil; env.websocket={connect=function() end}",
      ),
    ).toEqual([true])
  })

  test("replacing the live agent invalidates references from its actual predecessor", async () => {
    expect(
      await scenario(`
      local ref = agent.handlers.listScripts({query="Script"}).scripts[1].ref
      local previous = agent.sessionId
      reloadAgent()
      assert(agent.sessionId ~= previous)
      local ok, err = pcall(agent.handlers.inspect, {ref=ref})
      assert(not ok and err.code == "stale_reference")
      return true
    `),
    ).toEqual([true])
  })

  test("actual operation results satisfy the TypeScript boundary schemas", async () => {
    const fixture = await createFixture()
    try {
      const [raw] = await fixture.run(`
        local row = agent.handlers.listScripts({query="Script"}).scripts[1]
        return hostJson({
          listInstances=agent.handlers.listInstances({}),
          listScripts=agent.handlers.listScripts({}),
          readSource=agent.handlers.readSource({ref=row.ref}),
          searchSource=agent.handlers.searchSource({query="target_behavior",mode="expand"}),
          inspect=agent.handlers.inspect({ref=row.ref,properties={"Name"},ancestry=true}),
          validate=agent.handlers.validate({code="return 1"}),
          eval=agent.handlers.eval({code="return 1,nil"}),
        })
      `)
      const outputs = JSON.parse(String(raw)) as Record<string, unknown>
      for (const [method, schema] of Object.entries(resultSchemas)) {
        expect(schema.safeParse(outputs[method]), method).toMatchObject({ success: true })
      }
    } finally {
      fixture.close()
    }
  })
  test("nil-only discovery includes descendants of detached ancestors", async () => {
    expect(
      await scenario(
        `
      local page = agent.handlers.listInstances({scope="nil"})
      local names = {}
      for _, row in ipairs(page.children) do names[row.name] = true end
      assert(names.Detached and names.Child)
      return true
    `,
        "env.getinstances=nil; env.getscripts=nil; env.getloadedmodules=nil; env.getrunningscripts=nil",
      ),
    ).toEqual([true])
  })

  test("source and search continuations do not lose long lines or repeated matches", async () => {
    expect(
      await scenario(`
      local ref = agent.handlers.listScripts({query="Script"}).scripts[1].ref
      generic.source = string.rep("x", 9000)
      local page = agent.handlers.readSource({ref=ref})
      local joined = page.data
      while page.nextLine do
        page = agent.handlers.readSource({ref=ref,startLine=page.nextLine,startColumn=page.nextColumn})
        joined ..= page.data
      end
      assert(joined == generic.source)
      generic.source = "needle one\\nneedle two\\nneedle three"
      agent.handlers.readSource({ref=ref,refresh=true})
      local matches, lines = agent.handlers.searchSource({query="needle",mode="expand",refs={ref},limit=1}), {}
      while true do
        for _, match in ipairs(matches.matches) do assert(not lines[match.line]); lines[match.line] = true end
        if not matches.nextCursor then break end
        matches = agent.handlers.searchSource({cursor=matches.nextCursor,limit=1})
      end
      assert(lines[1] and lines[2] and lines[3])
      return true
    `),
    ).toEqual([true])
  })

  test("async requests preserve execution ownership and report busy, cancel, timeout", async () => {
    expect(
      await scenario(
        `
      local received = {}
      local function deliver(result) received[result.id] = result end
      agent.handleRequest({sessionId=agent.sessionId,type="request",id="a",method="eval",params={code="return 7"}}, deliver)
      agent.handleRequest({sessionId=agent.sessionId,type="request",id="busy",method="eval",params={code="return 8"}}, deliver)
      assert(received.busy.error.code == "busy")
      pending[1].fn()
      assert(received.a.ok and received.a.result.values[1] == 7)
      agent.handleRequest({sessionId=agent.sessionId,type="request",id="b",method="eval",params={code="return 8"}}, deliver)
      cancelFails = true
      agent.handleRequest({sessionId=agent.sessionId,type="cancel",id="b"}, deliver)
      agent.handleRequest({sessionId=agent.sessionId,type="request",id="stillbusy",method="eval",params={code="return 9"}}, deliver)
      assert(received.stillbusy.error.code == "busy")
      cancelFails = false
      agent.handleRequest({sessionId=agent.sessionId,type="cancel",id="b"}, deliver)
      assert(received.b.error.code == "cancelled")
      agent.handleRequest({sessionId=agent.sessionId,type="request",id="c",method="eval",params={code="return 10"}}, deliver)
      timers[#timers].fn()
      assert(received.c.error.code == "timeout")
      agent.handleRequest({sessionId=agent.sessionId,type="request",id="d",method="eval",params={code="return 11"}}, deliver)
      cancelFails = true
      assert(not pcall(reloadAgent))
      cancelFails = false
      pending[#pending].fn()
      assert(received.d.ok)
      reloadAgent()
      return true
    `,
        `pending={}; timers={}
      task.defer=function(fn) local item={fn=fn}; table.insert(pending,item); return item end
      task.delay=function(_,fn) local item={fn=fn}; table.insert(timers,item); return item end
      task.cancel=function(item) if cancelFails then error("cannot cancel") end; item.cancelled=true end
      print=function() end`,
      ),
    ).toEqual([true])
  })
  test("exact references distinguish duplicate names and ambiguous paths fail", async () => {
    expect(
      await scenario(`
      local page = agent.handlers.listScripts({query="Duplicate"})
      assert(#page.scripts == 2 and page.scripts[1].ref ~= page.scripts[2].ref)
      local a = agent.handlers.readSource({ref=page.scripts[1].ref})
      local b = agent.handlers.readSource({ref=page.scripts[2].ref})
      assert(a.data ~= b.data)
      local ok, err = pcall(agent.handlers.readSource, {path=page.scripts[1].path})
      assert(not ok and err.code == "resolution")
      return true
    `),
    ).toEqual([true])
  })

  test("global inventory includes detached descendants and unparented scripts", async () => {
    expect(
      await scenario(`
      local page = agent.handlers.listScripts({scope="all"})
      local found = {}
      for _, row in ipairs(page.scripts) do
        if row.name == "Detached" or row.name == "Child" then
          local inspected = agent.handlers.inspect({ref=row.ref, properties={"Name"}, ancestry=true})
          assert(inspected.properties.Name.ok)
          assert(agent.handlers.readSource({ref=row.ref}).kind == "luau")
          found[row.name] = true
        end
      end
      assert(found.Detached and found.Child)
      local ok, err = pcall(agent.handlers.inspect, {ref="old-session:1"})
      assert(not ok and err.code == "stale_reference")
      return true
    `),
    ).toEqual([true])
  })

  test.each([
    ["env.getrunningscripts=nil", "running", "unavailable"],
    ['env.getloadedmodules=function() error("getter broke") end', "loaded", "failed"],
    ["env.getscripts=function() return {} end", "cached", "ok"],
  ])("scope-specific getter remains truthful: %s", async (setup, scope, status) => {
    expect(
      await scenario(
        `
      local page = agent.handlers.listScripts({scope=${JSON.stringify(scope)}})
      assert(#page.scripts == 0)
      assert(page.coverage.sources[1].status == ${JSON.stringify(status)})
      assert(page.coverage.complete == ${status === "ok"})
      return true
    `,
        setup,
      ),
    ).toEqual([true])
  })

  test.each([
    "env.getinstances=nil",
    'env.getinstances=function() error("failed inventory") end',
  ])("nil inventory never hides normal game tree: %s", async (setup) => {
    expect(
      await scenario(
        `
        local page = agent.handlers.listScripts({scope="all"})
        local names = {}
        for _, row in ipairs(page.scripts) do names[row.name] = true end
        assert(names.Script and names.Duplicate and names.Detached)
        assert(not page.coverage.complete)
        return true
      `,
        setup,
      ),
    ).toEqual([true])
  })

  test("pagination freezes rows, lists each reference once, expires explicitly", async () => {
    expect(
      await scenario(`
      local page = agent.handlers.listScripts({limit=1})
      local total, seen, count = page.total, {}, 0
      local cursor = page.nextCursor
      local forged = cursor:gsub("@%d+$", "@3")
      local accepted, failure = pcall(agent.handlers.listScripts, {cursor=forged,limit=1})
      assert(not accepted and failure.code == "expired_cursor")
      first.Name = "RenamedAfterSnapshot"
      table.insert(all, make("NewAfterSnapshot", "LocalScript", nil, "return 1"))
      while true do
        for _, row in ipairs(page.scripts) do
          assert(not seen[row.ref] and row.name ~= "RenamedAfterSnapshot" and row.name ~= "NewAfterSnapshot")
          seen[row.ref] = true; count += 1
        end
        if not page.nextCursor then break end
        page = agent.handlers.listScripts({cursor=page.nextCursor,limit=1})
      end
      assert(count == total)
      clock = 61
      local ok, err = pcall(agent.handlers.listScripts, {cursor=cursor})
      assert(not ok and err.code == "expired_cursor")
      return true
    `),
    ).toEqual([true])
  })

  test("partial and cached zero-match search cannot claim absence", async () => {
    expect(
      await scenario(`
      local cached = agent.handlers.searchSource({query="missing"})
      assert(#cached.matches == 0 and not cached.coverage.complete)
      local partial = agent.handlers.searchSource({query="missing",mode="expand",maxScripts=1})
      assert(#partial.matches == 0 and not partial.coverage.complete and partial.nextCursor)
      local result = agent.handlers.searchSource({query="target_behavior",mode="expand",maxScripts=20})
      assert(#result.matches == 1 and result.matches[1].line == 2)
      assert(result.matches[1].provenance == "decompiled")
      return true
    `),
    ).toEqual([true])
  })

  test("failed extraction retries, successful cache refresh preserves provenance", async () => {
    expect(
      await scenario(`
      local ref = agent.handlers.listScripts({query="Script"}).scripts[1].ref
      failExtraction = true
      local failed = agent.handlers.readSource({ref=ref})
      assert(failed.kind == "unavailable" and failed.failures[1].status == "failed")
      failExtraction = false
      local source = agent.handlers.readSource({ref=ref,lineCount=1})
      assert(source.kind == "luau" and source.provenance == "decompiled" and source.cache == "miss")
      assert(source.nextLine == 2 and source.truncated)
      generic.source = "return 'updated'"
      assert(agent.handlers.readSource({ref=ref}).cache == "hit")
      local refreshed = agent.handlers.readSource({ref=ref,refresh=true})
      assert(refreshed.cache == "refreshed" and refreshed.data == generic.source)
      return true
    `),
    ).toEqual([true])
  })

  test("constants are evidence without line numbers; bytecode is explicit and bounded", async () => {
    expect(
      await scenario(
        `
      local ref = agent.handlers.listScripts({query="Script"}).scripts[1].ref
      local source = agent.handlers.readSource({ref=ref})
      assert(source.kind == "constants" and source.provenance == "constants")
      local found = agent.handlers.searchSource({query="needle",mode="cached"})
      assert(found.matches[1].line == nil and found.matches[1].provenance == "constants")
      local bytes = agent.handlers.readSource({ref=ref,representation="bytecode",byteCount=4})
      assert(bytes.kind == "bytecode" and #bytes.data == 8 and bytes.nextByteOffset == 5)
      return true
    `,
        `env.decompile=nil; env.getscriptclosure=function() return function() end end
      env.getconstants=function() return {"needle"} end
      env.getscriptbytecode=function() return string.rep("x",10000) end`,
      ),
    ).toEqual([true])
  })

  test("expanded search recovers source after an explicit bytecode cache entry", async () => {
    expect(
      await scenario(
        `
        local ref = agent.handlers.listScripts({query="Script"}).scripts[1].ref
        assert(agent.handlers.readSource({ref=ref,representation="bytecode"}).kind == "bytecode")
        local found = agent.handlers.searchSource({query="target_behavior",mode="expand",refs={ref}})
        assert(#found.matches == 1 and found.matches[1].provenance == "decompiled" and found.matches[1].line == 2)
        local cached = agent.handlers.readSource({ref=ref})
        assert(cached.kind == "luau" and cached.cache == "hit")
        return true
      `,
        'env.getscriptbytecode=function() return "opaque-bytecode" end',
      ),
    ).toEqual([true])
  })

  test("validation compiles without execution and eval errors preserve categories and nils", async () => {
    expect(
      await scenario(`
      assert(agent.handlers.validate({code="error('must not execute')"}).valid)
      assert(not agent.handlers.validate({code="local ="}).valid)
      local ok, err = pcall(agent.handlers.eval, {code="local ="})
      assert(not ok and err.code == "compile")
      ok, err = pcall(agent.handlers.eval, {code="local function broken() error('intentional') end; broken()"})
      assert(not ok and err.code == "runtime" and err.details:find("broken"))
      local result = agent.handlers.eval({code="return 1,nil,3,nil"})
      assert(result.count == 4 and result.returned == 4 and result.values[2].type == "nil" and result.values[4].type == "nil")
      return true
    `),
    ).toEqual([true])
  })

  test("inspection reports per-field failures and nested long results obey byte budget", async () => {
    expect(
      await scenario(`
      local ref = agent.handlers.listScripts({query="Script"}).scripts[1].ref
      local inspected = agent.handlers.inspect({ref=ref,properties={"Explodes","Name"},tags=true,attributes=true})
      assert(not inspected.properties.Explodes.ok and inspected.properties.Name.ok)
      local ok, failure = pcall(agent.handlers.inspect, {ref=ref,properties={}})
      assert(not ok and failure.code == "invalid_request")
      local result = agent.handlers.eval({code="local t = {}; for i=1,1000 do t[i] = {string.rep('x',10000)} end; return t,string.rep('z',100000)"})
      assert(result.truncated and #hostJson(result) <= agent.limits.responseBytes)
      return true
    `),
    ).toEqual([true])
  })
})
