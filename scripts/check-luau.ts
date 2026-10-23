import { readFile } from "node:fs/promises"
import { LuauState } from "luau-web"

const state = await LuauState.createAsync()
try {
  state.loadstring(
    await readFile(new URL("../agent.lua", import.meta.url), "utf8"),
    "agent.lua",
    true,
  )
  console.log("agent.lua: Luau compilation passed (chunk was not executed)")
} finally {
  state.destroy()
}
