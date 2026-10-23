import { readFile } from "node:fs/promises"
import { LuauState, type LuauTable } from "luau-web"

export function plain(value: unknown, emptyArrays = false): unknown {
  if (value && typeof value === "object" && "keys" in value && "get" in value) {
    const table = value as LuauTable
    const keys = table.keys()
    if ((keys.length > 0 || emptyArrays) && keys.every((key) => typeof key === "number")) {
      return keys
        .sort((a, b) => Number(a) - Number(b))
        .map((key) => plain(table.get(key), emptyArrays))
    }
    return Object.fromEntries(keys.map((key) => [String(key), plain(table.get(key), emptyArrays)]))
  }
  return value
}

export const fixture = `
setfenv(1, setmetatable({}, {__index=getfenv()}))
local nativeTypeof = typeof
function typeof(value)
    if type(value) == "table" and rawget(value, "__instance") then return "Instance" end
    return nativeTypeof(value)
end
local serial = 0
local services = {}
local methods = {}
function methods:IsA(class)
    return self.ClassName == class or class == "Instance" or
        (class == "LuaSourceContainer" and (self.ClassName == "LocalScript" or self.ClassName == "ModuleScript"))
end
function methods:GetChildren() return table.clone(self.children) end
function methods:GetDescendants()
    local result = {}
    local function walk(node)
        for _, child in ipairs(node.children) do table.insert(result, child); walk(child) end
    end
    walk(self)
    return result
end
function methods:IsDescendantOf(parent)
    local current = self.Parent
    while current do if current == parent then return true end; current = current.Parent end
    return false
end
function methods:FindFirstChild(name)
    for _, child in ipairs(self.children) do if child.Name == name then return child end end
end
function methods:GetFullName()
    if self.Parent then return self.Parent:GetFullName() .. "." .. self.Name end
    return self.Name
end
function methods:GetAttributes() return {fixture = true} end
function methods:GetAttribute(name) return self:GetAttributes()[name] end
function methods:GetTags() return {"fixture"} end
function methods:GetService(name) return services[name] end
function make(name, class, parent, source)
    local item = setmetatable({__instance=true, Name=name, ClassName=class, Parent=parent, children={}, source=source}, {
        __index=function(self, key)
            if key == "Explodes" then error("property inaccessible") end
            return methods[key]
        end,
    })
    if parent then table.insert(parent.children, item) end
    return item
end
game = make("game", "DataModel")
game.PlaceId = 123; game.JobId = "fixture-job"; game.PlaceVersion = 7
local workspace = make("Workspace", "Workspace", game)
local replicated = make("ReplicatedStorage", "ReplicatedStorage", game)
services.Workspace = workspace; services.ReplicatedStorage = replicated
services.Players = {LocalPlayer={Name="Fixture", UserId=456}}
services.CollectionService = {GetTags=function(_, item) return item:GetTags() end}
services.HttpService = {
    GenerateGUID=function() serial += 1; return "fixture-session-" .. serial end,
    JSONEncode=function(_, value) return hostJson(value) end,
    JSONDecode=function() error("unused JSON decoder") end,
}
first = make("Duplicate", "LocalScript", replicated, "local speed = 12\\nreturn speed")
second = make("Duplicate", "LocalScript", replicated, "local speed = 99\\nreturn speed")
generic = make("Script", "LocalScript", workspace, "local function jump()\\n    return 'target_behavior'\\nend\\nreturn jump()")
orphan = make("Detached", "ModuleScript", nil, "return 'orphan-evidence'")
detached = make("Folder", "Folder")
descendant = make("Child", "ModuleScript", detached, "return 'detached-child'")
all = {workspace,replicated,first,second,generic,orphan,detached,descendant}
nilItems = {orphan,detached}
clock = 0
os = {clock=function() return clock end, time=function() return 123456 end}
task = {wait=function() end, spawn=function() error("test mode must not start transport") end}
env = {
    RobloxClientMcp={Token=string.rep("x",32), TestMode=true},
    loadstring=function(source, name)
        local result = hostCompile(source, name)
        if type(result) == "string" then return nil,result end
        setfenv(result, getfenv())
        return result
    end,
    getinstances=function() return all end,
    getnilinstances=function() return nilItems end,
    getscripts=function() return {first,second,generic,orphan,descendant} end,
    getloadedmodules=function() return {orphan,descendant} end,
    getrunningscripts=function() return {first,generic} end,
    decompile=function(item)
        if failExtraction then error("temporary extraction failure") end
        return item.source
    end,
}
function getgenv() return env end
`

export async function createFixture(setup = "") {
  const state: LuauState = await LuauState.createAsync({
    hostJson: (value: unknown) => JSON.stringify(plain(value, true)),
    hostCompile: (source: string, name: string) => state.loadstring(source, name, false),
  })
  const source = await readFile(new URL("../agent.lua", import.meta.url), "utf8")
  const [run] = await state.loadstring(
    `${fixture}\n${setup}\nlocal function loadAgent()\n${source}\nend\nagent = loadAgent()\nfunction reloadAgent() agent = loadAgent() end\nreturn function(fn) setfenv(fn, getfenv()); return fn() end`,
    "fixture",
    true,
  )()
  return {
    state,
    async run(code: string): Promise<unknown[]> {
      return (await run(state.loadstring(code, "scenario", true))) as unknown[]
    },
    close() {
      state.destroy()
    },
  }
}
