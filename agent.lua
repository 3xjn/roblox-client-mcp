local HttpService = game:GetService("HttpService")
local Players = game:GetService("Players")

assert(type(getgenv) == "function", "getgenv is required")
local environment = getgenv()
local configuration = assert(environment.RobloxClientMcp, "Set getgenv().RobloxClientMcp before loading the agent")
local token = assert(configuration.Token, "RobloxClientMcp.Token is required")
local endpoint = configuration.Url or "ws://127.0.0.1:32145/live"
endpoint = endpoint:gsub("://localhost", "://127.0.0.1")

assert(type(token) == "string" and #token >= 32, "RobloxClientMcp.Token must be at least 32 characters")
assert(type(endpoint) == "string", "RobloxClientMcp.Url must be a string")

local function envFunction(name)
    local value = environment[name]
    return type(value) == "function" and value or nil
end

local function nestedFunction(...)
    local current = environment
    for index = 1, select("#", ...) do
        if type(current) ~= "table" then
            return nil
        end
        current = current[select(index, ...)]
    end
    return type(current) == "function" and current or nil
end

local compile = envFunction("loadstring") or (type(loadstring) == "function" and loadstring)
assert(compile, "loadstring is required")

local websocketConnectors = {
    nestedFunction("WebSocket", "connect"),
    nestedFunction("websocket", "connect"),
    nestedFunction("WebSocket", "new"),
    nestedFunction("syn", "websocket", "connect"),
}
local httpRequest = envFunction("request")
    or nestedFunction("http", "request")
    or envFunction("http_request")
    or nestedFunction("syn", "request")
local writeFile = envFunction("writefile")
local readFile = envFunction("readfile")
local isFile = envFunction("isfile")
local makeFolder = envFunction("makefolder")
local getAllInstances = envFunction("getinstances")
local getNilInstances = envFunction("getnilinstances")
local getCachedScripts = envFunction("getscripts")
local getLoadedModules = envFunction("getloadedmodules")
local getRunningScripts = envFunction("getrunningscripts")
local decompileSource = envFunction("decompile")
local dumpBytecode = envFunction("getscriptbytecode") or envFunction("dumpstring")
local getScriptClosure = envFunction("getscriptclosure") or envFunction("getscriptfunction")
local debugLibrary = environment.debug
local getConstants = type(debugLibrary) == "table"
        and type(debugLibrary.getconstants) == "function"
        and debugLibrary.getconstants
    or envFunction("getconstants")
local identify = envFunction("identifyexecutor") or envFunction("getexecutorname")

local filePollRoot = type(configuration.FilePoll) == "string" and configuration.FilePoll or "roblox-client-mcp"
local toHostPath = filePollRoot .. "/to-host.json"
local toAgentPath = filePollRoot .. "/to-agent.json"

local function hasWebsocketConnector()
    for index = 1, 4 do
        local connector = websocketConnectors[index]
        if connector then
            return true
        end
    end
    return false
end

local function decodeJson(source)
    if type(source) ~= "string" then
        return nil
    end
    local decoded, value = pcall(HttpService.JSONDecode, HttpService, source)
    if decoded and type(value) == "table" then
        return value
    end
end

if environment.RobloxClientMcpAgent then
    assert(environment.RobloxClientMcpAgent.Stop() ~= false,
        "Previous agent still owns an execution that could not be cancelled; retry after it completes")
end

local function executorInfo()
    if not identify then
        return nil
    end
    local succeeded, name, version = pcall(identify)
    if not succeeded then
        return nil
    end
    local info = {}
    if type(name) == "string" and #name > 0 then
        info.name = name
    end
    if type(version) == "string" and #version > 0 then
        info.version = version
    end
    return next(info) and info or nil
end

local function skipWhitespace(source, position)
    local _, last = source:find("^%s*", position)
    return (last or position - 1) + 1
end

local function parseQuoted(source, position)
    local quote = source:sub(position, position)
    if quote ~= '"' and quote ~= "'" then
        return nil, position, "Expected a quoted instance name"
    end

    local escaped = false
    local cursor = position + 1
    while cursor <= #source do
        local character = source:sub(cursor, cursor)
        if escaped then
            escaped = false
        elseif character == "\\" then
            escaped = true
        elseif character == quote then
            local literal = source:sub(position, cursor)
            local chunk, compileError = compile("return " .. literal, "instance path segment")
            if not chunk then
                return nil, cursor, compileError
            end
            local succeeded, value = pcall(chunk)
            if not succeeded or type(value) ~= "string" then
                return nil, cursor, tostring(value)
            end
            return value, cursor + 1
        end
        cursor += 1
    end

    return nil, cursor, "Unterminated quoted instance name"
end

local function uniqueChild(parent, name)
    local found
    for _, child in ipairs(parent:GetChildren()) do
        if child.Name == name then
            if found then return nil, 'Ambiguous instance path segment: ' .. name end
            found = child
        end
    end
    if not found then return nil, 'Could not resolve "' .. name .. '"' end
    return found
end

local function resolvePath(source)
    if type(source) ~= "string" then
        return nil, "Instance path must be a string"
    end

    source = source:match("^%s*(.-)%s*$")
    local current
    local position
    if source:sub(1, 4) == "game" then
        current = game
        position = 5
    elseif source:sub(1, 9) == "workspace" then
        current = workspace
        position = 10
    else
        return nil, 'Instance paths must begin with "game" or "workspace"'
    end

    while position <= #source do
        position = skipWhitespace(source, position)
        if position > #source then
            break
        end

        if source:sub(position, position + 11) == ":GetService(" then
            if current ~= game then
                return nil, "GetService is only valid on game"
            end
            position = skipWhitespace(source, position + 12)
            local name, nextPosition, parseError = parseQuoted(source, position)
            if not name then
                return nil, parseError
            end
            position = skipWhitespace(source, nextPosition)
            if source:sub(position, position) ~= ")" then
                return nil, "Expected ) after GetService"
            end
            local succeeded, service = pcall(game.GetService, game, name)
            if not succeeded then
                return nil, tostring(service)
            end
            current = service
            position += 1
        elseif source:sub(position, position) == "." then
            local name = source:match("^([%a_][%w_]*)", position + 1)
            if not name then
                return nil, "Expected a member name after ."
            end
            local child, childError = uniqueChild(current, name)
            if not child then return nil, childError end
            current = child
            position += #name + 1
        elseif source:sub(position, position) == "[" then
            position = skipWhitespace(source, position + 1)
            local name, nextPosition, parseError = parseQuoted(source, position)
            if not name then
                return nil, parseError
            end
            position = skipWhitespace(source, nextPosition)
            if source:sub(position, position) ~= "]" then
                return nil, "Expected ] after instance name"
            end
            local child, childError = uniqueChild(current, name)
            if not child then return nil, childError end
            current = child
            position += 1
        else
            return nil, ("Unexpected path syntax at character %d"):format(position)
        end
    end

    return current
end

local function getInstancePath(instance)
    if instance == game then
        return "game"
    end
    if instance == workspace then
        return "workspace"
    end
    if not instance.Parent then
        return ("<nil>[%q]"):format(instance.Name)
    end

    local segments = {}
    local current = instance
    while current.Parent and current.Parent ~= game and current ~= workspace do
        table.insert(segments, 1, ("[%q]"):format(current.Name))
        current = current.Parent
    end

    local root
    if current == workspace then
        root = "workspace"
    elseif current.Parent == game then
        root = ("game:GetService(%q)"):format(current.Name)
    else
        root = ("<nil>[%q]"):format(current.Name)
    end
    return root .. table.concat(segments)
end

local limits = {
    responseBytes = 32768, refMax = 10000, listDefault = 50, listMax = 200, candidateMax = 5000,
    snapshots = 8, snapshotTtlSeconds = 60, cursorWindow = 256, sourceLinesDefault = 100, sourceLinesMax = 500,
    sourceCacheEntries = 64, sourceCacheBytes = 2097152, sourceBytes = 262144,
    searchExpansionDefault = 5, searchExpansionMax = 20,
}
local sessionId = HttpService:GenerateGUID(false)
local function fail(code, message, details)
    error({ code = code, message = tostring(message):sub(1, 2048), details = details }, 0)
end
local function integer(value, default, maximum)
    if value == nil then return default end
    if type(value) ~= "number" or value % 1 ~= 0 or value < 1 or value > maximum then
        fail("invalid_request", "Expected an integer between 1 and " .. maximum)
    end
    return value
end
local function textValue(value, default, maximum)
    if value == nil then return default end
    if type(value) ~= "string" or #value > maximum then fail("invalid_request", "Invalid string argument") end
    return value
end
local function yieldWork(index)
    if index % 100 == 0 then task.wait() end
end
local refByInstance = setmetatable({}, { __mode = "k" })
local instanceByRef = setmetatable({}, { __mode = "v" })
local referenceQueue, referenceCounter = {}, 0
local function reference(instance)
    local existing = refByInstance[instance]
    if existing and instanceByRef[existing] then return existing end
    referenceCounter += 1
    local ref = sessionId .. ":" .. referenceCounter
    refByInstance[instance], instanceByRef[ref] = ref, instance
    table.insert(referenceQueue, ref)
    if #referenceQueue > limits.refMax then instanceByRef[table.remove(referenceQueue, 1)] = nil end
    return ref
end
local function resolveTarget(params, defaultGame)
    if params.ref ~= nil and params.path ~= nil then fail("invalid_request", "Provide ref or path, not both") end
    if params.ref ~= nil then
        if type(params.ref) ~= "string" then fail("invalid_request", "ref must be a string") end
        local instance = instanceByRef[params.ref]
        if not instance then fail("stale_reference", "Reference is missing, expired, or belongs to another live agent") end
        return instance
    end
    if params.path ~= nil then
        local instance, message = resolvePath(params.path)
        if not instance then fail("resolution", message) end
        return instance
    end
    if defaultGame then return game end
    fail("invalid_request", "Provide one exact ref or an unambiguous path")
end
local function isScript(instance)
    return typeof(instance) == "Instance" and instance:IsA("LuaSourceContainer") and not instance:IsA("CoreScript")
end
local function describeInstance(instance)
    local succeeded, children = pcall(instance.GetChildren, instance)
    return { ref = reference(instance), name = instance.Name:sub(1, 512), className = instance.ClassName,
        path = getInstancePath(instance):sub(1, 2048), childCount = succeeded and #children or nil,
        childCountError = not succeeded and tostring(children):sub(1, 128) or nil, isScript = isScript(instance) }
end
local function encodedSize(value)
    local ok, encoded = pcall(HttpService.JSONEncode, HttpService, value)
    return ok and #encoded or math.huge
end
local function serialize(value, depth, seen, budget)
    budget = budget or { remaining = 10000, truncated = false }
    if budget.remaining < 64 then budget.truncated = true return { type = "truncated", reason = "response_budget" } end
    budget.remaining -= 64
    local valueType = typeof(value)
    if value == nil then return { type = "nil" } end
    if valueType == "boolean" then return value end
    if valueType == "string" then
        local cap = math.min(2048, math.floor(budget.remaining / 6))
        if #value > cap then
            budget.remaining -= cap * 6
            budget.truncated = true
            return { type = "string", value = value:sub(1, cap), truncated = true, totalBytes = #value }
        end
        budget.remaining -= #value * 6
        return value
    end
    if valueType == "number" then
        if value ~= value or value == math.huge or value == -math.huge then return { type = "number", value = tostring(value) } end
        return value
    end
    if valueType == "Instance" then
        budget.remaining -= 512
        return { type = "Instance", ref = reference(value), className = value.ClassName, name = value.Name:sub(1, 128), path = getInstancePath(value):sub(1, 256) }
    end
    if valueType ~= "table" then return { type = valueType, value = tostring(value):sub(1, 256) } end
    if depth >= 6 then budget.truncated = true return { type = "table", truncated = true, reason = "depth" } end
    if seen[value] then return { type = "table", circular = true } end
    seen[value] = true
    local entries, truncated = {}, false
    for key, child in next, value do
        if #entries >= 100 or budget.remaining < 128 then truncated = true budget.truncated = true break end
        table.insert(entries, { key = serialize(key, depth + 1, seen, budget), value = serialize(child, depth + 1, seen, budget) })
    end
    seen[value] = nil
    return { type = "table", entries = entries, truncated = truncated }
end
local function getterValues(name, getter)
    if not getter then return {}, { source = name, status = "unavailable" } end
    local ok, values = pcall(getter)
    if not ok or type(values) ~= "table" then
        return {}, { source = name, status = "failed", error = tostring(values):sub(1, 512) }
    end
    return values, { source = name, status = "ok", count = #values }
end
local function inventory(scope, scriptsOnly, root)
    local values, seen, sources = {}, {}, {}
    local capped, scanned = false, 0
    local function append(list)
        for index, instance in ipairs(list) do
            if scanned >= limits.candidateMax then capped = true break end
            scanned += 1
            if typeof(instance) == "Instance" and not seen[instance] and (not scriptsOnly or isScript(instance))
                and (not root or instance == root or instance:IsDescendantOf(root)) then
                if #values >= limits.candidateMax then capped = true break end
                seen[instance] = true table.insert(values, instance)
            end
            yieldWork(index)
        end
    end
    local function getter(name, fn)
        local list, status = getterValues(name, fn)
        table.insert(sources, status) append(list)
        if name == "getnilinstances" then
            for index, instance in ipairs(list) do
                if scanned >= limits.candidateMax then capped = true break end
                if typeof(instance) == "Instance" then
                    local ok, descendants = pcall(instance.GetDescendants, instance)
                    if ok then append(descendants) else status.status = "failed" status.error = tostring(descendants):sub(1, 512) end
                end
            end
        end
        return status.status == "ok"
    end
    if scope == "children" then
        local list, status = getterValues("children", function() return root:GetChildren() end)
        table.insert(sources, status) append(list)
    elseif scope == "nil" then
        getter("getnilinstances", getNilInstances)
    elseif scope == "running" then getter("getrunningscripts", getRunningScripts)
    elseif scope == "loaded" then getter("getloadedmodules", getLoadedModules)
    elseif scope == "cached" then getter("getscripts", getCachedScripts)
    elseif scope == "all" then
        -- The normal tree remains part of global inventory even if executor getters fail.
        getter("game", function() local list = game:GetDescendants() table.insert(list, 1, game) return list end)
        getter("getinstances", getAllInstances)
        getter("getnilinstances", getNilInstances)
        if scriptsOnly then
            getter("getscripts", getCachedScripts)
            getter("getrunningscripts", getRunningScripts)
            getter("getloadedmodules", getLoadedModules)
        end
    else fail("invalid_request", "Invalid inventory scope") end
    local complete = not capped
    for _, status in ipairs(sources) do if status.status ~= "ok" then complete = false end end
    return values, { complete = complete, scanned = scanned, limitReached = capped, sources = sources }
end
local snapshots, snapshotOrder, snapshotCounter = {}, {}, 0
local function snapshot(kind, state)
    local now = os.clock()
    for index = #snapshotOrder, 1, -1 do
        local id = snapshotOrder[index]
        if not snapshots[id] or snapshots[id].expires <= now then snapshots[id] = nil table.remove(snapshotOrder, index) end
    end
    while #snapshotOrder >= limits.snapshots do snapshots[table.remove(snapshotOrder, 1)] = nil end
    snapshotCounter += 1
    local id = sessionId .. "/" .. snapshotCounter
    state.kind, state.expires = kind, now + limits.snapshotTtlSeconds
    state.cursors, state.cursorOrder = {}, {}
    snapshots[id] = state table.insert(snapshotOrder, id)
    return id
end
local function getSnapshot(cursor, kind)
    if type(cursor) ~= "string" then fail("invalid_request", "cursor must be a string") end
    local id, index = cursor:match("^(.*)@(%d+)$")
    local state = id and snapshots[id]
    if not state or state.expires <= os.clock() then fail("expired_cursor", "Cursor expired or belongs to another live agent; restart the query") end
    if state.kind ~= kind then fail("invalid_request", "Cursor belongs to a different operation") end
    index = tonumber(index)
    if not state.cursors[index] then fail("expired_cursor", "Cursor was not issued or is outside the retained continuation window") end
    return state, id, index
end
local function continuation(state, id, position)
    if not state.cursors[position] then
        state.cursors[position] = true table.insert(state.cursorOrder, position)
        if #state.cursorOrder > limits.cursorWindow then state.cursors[table.remove(state.cursorOrder, 1)] = nil end
    end
    return id .. "@" .. position
end
local function rank(instance, query)
    local name, path = string.lower(instance.Name), string.lower(getInstancePath(instance))
    if query == "" then return 4, "inventory", path end
    if name == query then return 0, "exact_name", path end
    if name:sub(1, #query) == query then return 1, "name_prefix", path end
    if name:find(query, 1, true) then return 2, "name", path end
    if path:find(query, 1, true) then return 3, "path", path end
    return nil
end
local handlers = {}
local function list(params, scriptsOnly)
    local kind = scriptsOnly and "listScripts" or "listInstances"
    local limit = integer(params.limit, limits.listDefault, limits.listMax)
    local state, id, position
    if params.cursor then state, id, position = getSnapshot(params.cursor, kind)
    else
        local scope = textValue(params.scope, scriptsOnly and "all" or "children", 32)
        local allowed = scriptsOnly and { all = true, running = true, loaded = true, cached = true }
            or { all = true, children = true, ["nil"] = true }
        if not allowed[scope] then fail("invalid_request", "Invalid scope for this operation") end
        local root
        if scope == "nil" and (params.ref ~= nil or params.path ~= nil) then fail("invalid_request", "nil scope does not accept a root") end
        if params.ref ~= nil or params.path ~= nil or scope == "children" then root = resolveTarget(params, scope == "children") end
        local values, coverage = inventory(scope, scriptsOnly, root)
        local query = string.lower(textValue(params.query, "", 256))
        local className = textValue(params.className, "", 128)
        local candidates = {}
        for index, instance in ipairs(values) do
            if className == "" or instance.ClassName == className then
                local score, matched, path = rank(instance, query)
                if score then table.insert(candidates, { instance = instance, score = score, matched = matched, path = path, ref = reference(instance) }) end
            end
            yieldWork(index)
        end
        table.sort(candidates, function(a, b)
            if a.score ~= b.score then return a.score < b.score end
            if a.path ~= b.path then return a.path < b.path end
            return a.ref < b.ref
        end)
        -- Freeze descriptive metadata at snapshot creation, but defer expensive child counts until returned.
        local rows = {}
        for _, candidate in ipairs(candidates) do
            local instance = candidate.instance
            table.insert(rows, { ref = candidate.ref, name = instance.Name:sub(1, 512), className = instance.ClassName,
                path = candidate.path:sub(1, 2048), isScript = isScript(instance), match = candidate.matched })
        end
        state = { rows = rows, scope = scope, query = query, className = className, coverage = coverage,
            instance = root and describeInstance(root) or nil }
        id, position = snapshot(kind, state), 1
    end
    if position < 1 or position > #state.rows + 1 then fail("invalid_request", "Invalid cursor position") end
    local rows, bytes = {}, 0
    while position <= #state.rows and #rows < limit do
        local frozen = state.rows[position]
        local row = table.clone(frozen)
        local instance = instanceByRef[row.ref]
        if instance then
            local ok, children = pcall(instance.GetChildren, instance)
            if ok then row.childCount = #children else row.childCountError = tostring(children):sub(1, 128) end
        else row.stale = true row.childCountError = "Reference expired after snapshot creation" end
        local size = encodedSize(row)
        if #rows > 0 and bytes + size > 22000 then break end
        table.insert(rows, row) bytes += size position += 1
    end
    return { [scriptsOnly and "scripts" or "children"] = rows, total = #state.rows, returned = #rows, scope = state.scope,
        query = state.query, className = state.className, coverage = state.coverage, instance = state.instance,
        nextCursor = position <= #state.rows and continuation(state, id, position) or nil }
end
function handlers.listInstances(params) return list(params, false) end
function handlers.listScripts(params) return list(params, true) end
local sourceCache, cacheOrder, cacheBytes = {}, {}, 0
local function putCache(ref, cached)
    if sourceCache[ref] then cacheBytes -= sourceCache[ref].bytes end
    for index = #cacheOrder, 1, -1 do if cacheOrder[index] == ref then table.remove(cacheOrder, index) end end
    sourceCache[ref] = cached cacheBytes += cached.bytes table.insert(cacheOrder, ref)
    while #cacheOrder > limits.sourceCacheEntries or cacheBytes > limits.sourceCacheBytes do
        local oldest = table.remove(cacheOrder, 1)
        cacheBytes -= sourceCache[oldest].bytes sourceCache[oldest] = nil
    end
end
local function recover(instance, refresh, bytecode)
    local ref = reference(instance)
    local cached = sourceCache[ref]
    if cached and not refresh and ((bytecode and cached.kind == "bytecode") or (not bytecode and cached.kind ~= "bytecode")) then return cached, "hit" end
    local failures = {}
    local function attempt(method, fn)
        if not fn then table.insert(failures, { method = method, status = "unavailable" }) return nil end
        local ok, value = pcall(fn)
        if not ok then table.insert(failures, { method = method, status = "failed", error = tostring(value):sub(1, 512) }) return nil end
        if type(value) ~= "string" or #value == 0 then table.insert(failures, { method = method, status = "failed", error = "No nonempty text returned" }) return nil end
        if #value > limits.sourceBytes then table.insert(failures, { method = method, status = "failed", error = "Recovery exceeds source byte limit" }) return nil end
        return value
    end
    if refresh and cached then
        sourceCache[ref] = nil cacheBytes -= cached.bytes
        for index = #cacheOrder, 1, -1 do if cacheOrder[index] == ref then table.remove(cacheOrder, index) end end
    end
    local data, kind, provenance, partial
    if bytecode then
        data = attempt("getscriptbytecode", dumpBytecode and function() return dumpBytecode(instance) end)
        kind, provenance = "bytecode", "bytecode"
    else
        data = attempt("decompile", decompileSource and function() return decompileSource(instance) end)
        kind, provenance = "luau", "decompiled"
        if not data then
            if not getScriptClosure or not getConstants then table.insert(failures, { method = "constants", status = "unavailable" })
            else
                local ok, constants = pcall(function() return getConstants(getScriptClosure(instance)) end)
                if ok and type(constants) == "table" then
                    local budget = { remaining = 10000, truncated = false }
                    data = serialize(constants, 0, {}, budget)
                    partial = budget.truncated
                    kind, provenance = "constants", "constants"
                else table.insert(failures, { method = "constants", status = "failed", error = tostring(constants):sub(1, 512) }) end
            end
        end
    end
    local result = { kind = data ~= nil and kind or "unavailable", provenance = data ~= nil and provenance or "none",
        data = data, failures = failures, partial = partial == true, bytes = type(data) == "string" and #data or encodedSize(data) }
    if data ~= nil then putCache(ref, result) end
    return result, refresh and "refreshed" or "miss"
end
local function hexEncode(data)
    return (data:gsub(".", function(character) return string.format("%02x", string.byte(character)) end))
end
local function sourcePage(source, startLine, lineCount, startColumn, pageBytes)
    local total, selected, bytes, endLine, nextColumn = 0, {}, 0, startLine - 1, nil
    for line in (source .. "\n"):gmatch("(.-)\n") do
        total += 1
        yieldWork(total)
        if total >= startLine and #selected < lineCount and bytes < pageBytes and not nextColumn then
            local column = total == startLine and startColumn or 1
            line = line:sub(column)
            local remaining = pageBytes - bytes
            if #line > remaining then line = line:sub(1, remaining) nextColumn = column + remaining end
            table.insert(selected, line) bytes += #line + 1 endLine = total
        end
    end
    return table.concat(selected, "\n"), endLine, total, endLine < total or nextColumn ~= nil, nextColumn
end
function handlers.readSource(params)
    local instance = resolveTarget(params)
    if not isScript(instance) then fail("resolution", "Target is not a supported script") end
    local representation = textValue(params.representation, "source", 32)
    if representation ~= "source" and representation ~= "bytecode" then fail("invalid_request", "representation must be source or bytecode") end
    local recovered, cache = recover(instance, params.refresh == true, representation == "bytecode")
    local result = { ref = reference(instance), path = getInstancePath(instance):sub(1, 2048), className = instance.ClassName,
        kind = recovered.kind, provenance = recovered.provenance, cache = cache, failures = recovered.failures }
    if recovered.kind == "luau" then
        result.startLine = integer(params.startLine, 1, 1000000)
        local count = integer(params.lineCount, limits.sourceLinesDefault, limits.sourceLinesMax)
        result.startColumn = integer(params.startColumn, 1, limits.sourceBytes + 1)
        result.data, result.endLine, result.totalLines, result.truncated, result.nextColumn = sourcePage(recovered.data, result.startLine, count, result.startColumn, math.min(4000, math.max(256, math.floor((limits.responseBytes - encodedSize(result) - 2048) / 6))))
        result.lineTruncated = result.nextColumn ~= nil
        if result.nextColumn then result.nextLine = result.endLine
        elseif result.endLine < result.totalLines then result.nextLine = result.endLine + 1 end
    elseif recovered.kind == "bytecode" then
        local offset = integer(params.byteOffset, 1, limits.sourceBytes + 1)
        local count = integer(params.byteCount, 1024, 4096)
        result.data = hexEncode(recovered.data:sub(offset, offset + count - 1))
        result.byteOffset, result.totalBytes = offset, #recovered.data
        result.byteCount = #result.data / 2
        result.truncated = offset + count <= #recovered.data
        result.nextByteOffset = result.truncated and offset + count or nil
    elseif recovered.kind == "constants" then result.data = recovered.data result.truncated = recovered.partial end
    return result
end
function handlers.inspect(params)
    local instance = resolveTarget(params)
    local result = { ref = reference(instance), path = getInstancePath(instance):sub(1, 2048), className = instance.ClassName, properties = {} }
    local properties = params.properties or { "Name", "Parent" }
    if type(properties) ~= "table" or #properties < 1 or #properties > 20 then fail("invalid_request", "properties must contain 1 to 20 property names") end
    local budget = { remaining = 10000, truncated = false }
    for _, property in ipairs(properties) do
        if type(property) ~= "string" or #property > 128 then fail("invalid_request", "Invalid property name") end
        local ok, value = pcall(function() return instance[property] end)
        result.properties[property] = ok and { ok = true, value = serialize(value, 0, {}, budget) } or { ok = false, error = tostring(value):sub(1, 512) }
    end
    if params.attributes then
        local ok, value = pcall(instance.GetAttributes, instance)
        result.attributes = ok and { ok = true, value = serialize(value, 0, {}, budget) } or { ok = false, error = tostring(value):sub(1, 512) }
    end
    if params.tags then
        local ok, value = pcall(function() return game:GetService("CollectionService"):GetTags(instance) end)
        result.tags = ok and { ok = true, value = serialize(value, 0, {}, budget) } or { ok = false, error = tostring(value):sub(1, 512) }
    end
    if params.ancestry then
        result.ancestry = {}
        local current = instance.Parent
        while current and #result.ancestry < 16 do
            table.insert(result.ancestry, { ref = reference(current), name = current.Name:sub(1, 128), className = current.ClassName })
            current = current.Parent
        end
        result.ancestryTruncated = current ~= nil
    end
    result.truncated = budget.truncated
    return result
end
local SEARCH_STRIDE = limits.sourceBytes + 2
local function searchMatches(recovered, query, ref, path, matches, maxMatches, offset)
    local evidence = {}
    if recovered.kind == "luau" then
        for line in (recovered.data .. "\n"):gmatch("(.-)\n") do table.insert(evidence, line) yieldWork(#evidence) end
    elseif recovered.kind == "constants" then
        local function visit(value, depth)
            if depth > 8 or #evidence >= 200 then return end
            if type(value) == "string" then table.insert(evidence, value)
            elseif type(value) == "table" then
                -- Serialized entries are ordered; only leaf string values are evidence.
                if value.entries then
                    for _, entry in ipairs(value.entries) do visit(entry.value, depth + 1) end
                elseif value.type == "string" then visit(value.value, depth + 1) end
            end
        end
        visit(recovered.data, 0)
    end
    for index = offset, #evidence do
        local line = evidence[index]
        local start = line:find(query, 1, true)
        if start then
            local match = { ref = ref, path = path, provenance = recovered.provenance,
                excerpt = line:sub(math.max(1, start - 60), start + #query + 160):sub(1, 256),
                line = recovered.kind == "luau" and index or nil }
            if #matches > 0 and encodedSize(matches) + encodedSize(match) > 20000 then return index end
            table.insert(matches, match)
            if #matches >= maxMatches and index < #evidence then return index + 1 end
        end
        yieldWork(index)
    end
    return nil
end
function handlers.searchSource(params)
    local limit = integer(params.limit, 20, 50)
    local maxScripts = integer(params.maxScripts, limits.searchExpansionDefault, limits.searchExpansionMax)
    local state, id, position
    if params.cursor then state, id, position = getSnapshot(params.cursor, "searchSource")
    else
        local query = textValue(params.query, nil, 256)
        if not query or query == "" then fail("invalid_request", "A nonempty literal query is required") end
        local mode = textValue(params.mode, "cached", 16)
        if mode ~= "cached" and mode ~= "expand" then fail("invalid_request", "mode must be cached or expand") end
        if params.refs and params.scope then fail("invalid_request", "Choose explicit refs or scope") end
        local refs, coverage = {}, { complete = false }
        if params.refs then
            if type(params.refs) ~= "table" or #params.refs > limits.candidateMax then fail("invalid_request", "Invalid candidate refs") end
            local seen = {}
            for index, ref in ipairs(params.refs) do
                yieldWork(index)
                local instance = resolveTarget({ ref = ref })
                if not isScript(instance) then fail("resolution", "Search candidate is not a script") end
                if not seen[ref] then seen[ref] = true table.insert(refs, ref) end
            end
            coverage.complete = true
        elseif mode == "cached" then
            for _, ref in ipairs(cacheOrder) do if instanceByRef[ref] and sourceCache[ref].kind ~= "bytecode" then table.insert(refs, ref) end end
        else
            local values
            local scope = textValue(params.scope, "all", 32)
            if scope ~= "all" and scope ~= "running" and scope ~= "loaded" and scope ~= "cached" then
                fail("invalid_request", "Invalid search scope")
            end
            values, coverage = inventory(scope, true, nil)
            for _, instance in ipairs(values) do table.insert(refs, reference(instance)) end
        end
        table.sort(refs)
        state = { refs = refs, query = query, mode = mode, inventory = coverage, unavailable = {}, partial = false, evidence = {}, evidenceBytes = 0 }
        id, position = snapshot("searchSource", state), SEARCH_STRIDE + 1
    end
    local candidate = math.floor(position / SEARCH_STRIDE)
    local offset = position % SEARCH_STRIDE
    if candidate < 1 or candidate > #state.refs + 1 or offset < 1 then fail("invalid_request", "Invalid search cursor position") end
    local matches, processed, searched = {}, 0, 0
    while candidate <= #state.refs and processed < maxScripts and #matches < limit do
        local ref = state.refs[candidate]
        local instance = instanceByRef[ref]
        local recovered = state.evidence[ref] or sourceCache[ref]
        if (not recovered or recovered.kind == "bytecode") and instance and state.mode == "expand" then recovered = recover(instance, false, false) end
        if recovered and recovered.kind ~= "unavailable" and recovered.kind ~= "bytecode" then
            -- Freeze source evidence up to the same bounded size as the shared cache.
            if not state.evidence[ref] and state.evidenceBytes + recovered.bytes <= limits.sourceCacheBytes then
                state.evidence[ref] = recovered state.evidenceBytes += recovered.bytes
            end
            if recovered.partial then state.partial = true end
            local nextOffset = searchMatches(recovered, state.query, ref,
                instance and getInstancePath(instance):sub(1, 2048) or "<expired>", matches, limit, offset)
            searched += 1 processed += 1
            if nextOffset then offset = nextOffset break end
        else state.unavailable[ref] = true processed += 1 end
        candidate += 1 offset = 1 task.wait()
    end
    local unavailable = 0
    for _ in pairs(state.unavailable) do unavailable += 1 end
    local remaining = math.max(0, #state.refs - candidate + 1)
    return { matches = matches, mode = state.mode, query = state.query,
        coverage = { complete = state.mode == "expand" and state.inventory.complete and remaining == 0 and unavailable == 0 and not state.partial,
            searched = searched, candidates = #state.refs, remaining = remaining, unavailable = unavailable,
            inventory = state.inventory, matchLimitReached = #matches >= limit },
        nextCursor = remaining > 0 and continuation(state, id, candidate * SEARCH_STRIDE + offset) or nil }
end
local function compileChunk(params)
    local code = textValue(params.code, nil, limits.sourceBytes)
    if not code then fail("invalid_request", "code is required") end
    local ok, chunk, message = pcall(compile, code, textValue(params.chunkName, "roblox-client-mcp", 128))
    if not ok then return nil, tostring(chunk):sub(1, 2048) end
    return chunk, message and tostring(message):sub(1, 2048) or nil
end
function handlers.validate(params)
    local chunk, message = compileChunk(params)
    if not chunk then return { valid = false, diagnostic = { code = "compile", message = message or "Compilation failed" } } end
    return { valid = true }
end
function handlers.eval(params)
    local chunk, message = compileChunk(params)
    if not chunk then fail("compile", message or "Compilation failed") end
    local results = table.pack(xpcall(chunk, function(err)
        local trace = type(debug) == "table" and type(debug.traceback) == "function" and debug.traceback(tostring(err), 2) or tostring(err)
        return { code = "runtime", message = tostring(err):sub(1, 2048), details = trace:sub(1, 4096) }
    end))
    if not results[1] then error(results[2], 0) end
    local values, budget = {}, { remaining = 10000, truncated = false }
    for index = 2, math.min(results.n, 102) do table.insert(values, serialize(results[index], 0, {}, budget)) end
    return { values = values, count = results.n - 1, returned = #values, truncated = budget.truncated or results.n > 102 }
end

local stopped = false
local socket
local inFlight = 0
local jobs = {}
local evalBusy = false
local transportName = "websocket"

local function capabilities()
    return {
        websocket = hasWebsocketConnector(),
        httpRequest = httpRequest ~= nil,
        writefile = writeFile ~= nil,
        readfile = readFile ~= nil,
        getinstances = getAllInstances ~= nil,
        getnilinstances = getNilInstances ~= nil,
        getscripts = getCachedScripts ~= nil,
        getloadedmodules = getLoadedModules ~= nil,
        getrunningscripts = getRunningScripts ~= nil,
        decompile = decompileSource ~= nil,
        getscriptbytecode = dumpBytecode ~= nil,
        getscriptclosure = getScriptClosure ~= nil,
        getconstants = getConstants ~= nil,
    }
end

local function helloPayload()
    local player = Players.LocalPlayer
    local payload = {
        type = "hello",
        token = token,
        agent = {
            agentVersion = "0.2.0",
            sessionId = sessionId,
            limits = limits,
            placeId = game.PlaceId,
            placeVersion = game.PlaceVersion,
            jobId = game.JobId,
            playerName = player and player.Name or "",
            userId = player and player.UserId or 0,
            transport = transportName,
            capabilities = capabilities(),
        },
    }
    local executor = executorInfo()
    if executor then
        payload.agent.executor = executor
    end
    return payload
end

local function pollEndpoint()
    if endpoint:sub(1, 4) == "http" then
        return endpoint
    end
    return (endpoint:gsub("^ws://", "http://"):gsub("^wss://", "https://")) .. "/poll"
end

local function sendJson(payload)
    if socket then
        pcall(function()
            socket:Send(HttpService:JSONEncode(payload))
        end)
    end
end

local function respond(id, succeeded, value)
    local payload = { type = "response", id = id, ok = succeeded, token = token, sessionId = sessionId }
    if succeeded then payload.result = value
    else payload.error = type(value) == "table" and value.code and value or { code = "internal", message = tostring(value):sub(1, 2048) } end
    if encodedSize(payload) > limits.responseBytes then
        payload.ok, payload.result = false, nil
        payload.error = { code = "response_budget", message = "Response exceeds 32768 bytes; request a smaller page or fewer fields" }
    end
    sendJson(payload)
    return payload
end

-- Log only lifecycle metadata, never code, results, tokens, or error payloads.
local function trace(job, event)
    print(string.format("[roblox-client-mcp] %s id=%s method=%s elapsedMs=%d",
        event, job.id, job.method, math.floor((os.clock() - job.started) * 1000)))
end

local function cancelAllJobs(event)
    for id, job in pairs(jobs) do
        local cancelled = pcall(task.cancel, job.thread)
        if cancelled then
            if job.timer then pcall(task.cancel, job.timer) end
            trace(job, event)
            jobs[id] = nil
            inFlight -= 1
        else
            trace(job, "cancel-failed")
        end
    end
    evalBusy = false
    for _, job in pairs(jobs) do if job.method == "eval" then evalBusy = true end end
    return next(jobs) == nil
end

local function handleRequest(request, deliver)
    if type(request) ~= "table" or type(request.id) ~= "string" then
        return
    end
    if request.sessionId ~= sessionId then
        local payload = respond(request.id, false, { code = "stale_reference", message = "Request belongs to a different live agent session" })
        if deliver then deliver(payload) end
        return payload
    end
    local function finish(job, succeeded, result, event)
        if jobs[job.id] ~= job then return end
        jobs[job.id] = nil
        inFlight -= 1
        if job.method == "eval" then evalBusy = false end
        if job.timer then pcall(task.cancel, job.timer) end
        trace(job, event)
        local payload = respond(job.id, succeeded, result)
        if deliver then deliver(payload) end
    end
    if request.type == "cancel" then
        local job = jobs[request.id]
        if job then
            local cancelled = pcall(task.cancel, job.thread)
            if cancelled then
                finish(job, false, { code = "cancelled", message = "Request cancelled; prior side effects are not rolled back" }, "cancelled")
            else
                trace(job, "cancel-failed")
            end
        else
            -- File polling can observe a cancellation that replaced an unread request.
            local payload = respond(request.id, false, { code = "cancelled", message = "Request was cancelled before execution" })
            if deliver then deliver(payload) end
        end
        return
    end
    if stopped or request.type ~= "request" or type(request.method) ~= "string" then return end
    if jobs[request.id] then return end
    local handler = handlers[request.method]
    local reason
    if not handler then reason = "Unknown method"
    elseif inFlight >= 8 then reason = "Too many live requests"
    elseif request.method == "eval" and evalBusy then reason = "Another evaluation is still running" end
    if reason then
        local payload = respond(request.id, false, { code = handler and "busy" or "invalid_request", message = reason })
        if deliver then deliver(payload) end
        return
    end
    local job = { id = request.id, method = request.method, started = os.clock() }
    jobs[job.id] = job
    inFlight += 1
    if job.method == "eval" then evalBusy = true end
    trace(job, "start")
    local timeoutMs = tonumber(request.timeoutMs) or 30000
    if timeoutMs ~= timeoutMs then timeoutMs = 30000 end
    timeoutMs = math.clamp(timeoutMs, 1, 120000)
    -- Defer keeps user code off the executor's socket callback stack.
    job.thread = task.defer(function()
        local succeeded, result = pcall(handler, request.params or {})
        finish(job, succeeded, result, succeeded and "complete" or "failed")
    end)
    job.timer = task.delay(timeoutMs / 1000, function()
        job.timer = nil
        local cancelled = pcall(task.cancel, job.thread)
        if cancelled then
            finish(job, false, { code = "timeout", message = "Request timed out; prior side effects are not rolled back" }, "timeout")
        else
            -- Keep this job registered so a failed cancellation cannot unlock eval.
            trace(job, "cancel-failed")
        end
    end)
end

local function handleMessage(message, isBinary)
    if isBinary then
        return
    end
    local request = decodeJson(message)
    if request then
        handleRequest(request)
    end
end

local function httpOk(response)
    if type(response) ~= "table" then
        return false
    end
    if response.Success == true or response.success == true then
        return true
    end
    local status = response.StatusCode or response.statusCode
    return status == 200
end

local function httpCall(payload)
    local response = httpRequest({
        Url = pollEndpoint(),
        Method = "POST",
        Headers = { ["Content-Type"] = "application/json" },
        Body = HttpService:JSONEncode(payload),
    })
    if not httpOk(response) then
        return nil
    end
    return decodeJson(response.Body or response.body)
end

local function fileRead(path)
    if isFile then
        local exists, present = pcall(isFile, path)
        if exists and present == false then
            return nil
        end
    end
    local succeeded, contents = pcall(readFile, path)
    if succeeded and type(contents) == "string" then
        return contents
    end
end

local function fileWrite(path, contents)
    return pcall(writeFile, path, contents)
end

local function attachSocket(connection)
    if type(connection) ~= "table" and type(connection) ~= "userdata" then
        return false
    end
    if type(connection.Send) ~= "function" or type(connection.Close) ~= "function" then
        return false
    end
    local onMessage = connection.OnMessage
    local onClose = connection.OnClose
    if type(onMessage) ~= "table" and type(onMessage) ~= "userdata" then
        return false
    end
    if type(onMessage.Connect) ~= "function" then
        return false
    end
    onMessage:Connect(handleMessage)
    if (type(onClose) == "table" or type(onClose) == "userdata") and type(onClose.Connect) == "function" then
        onClose:Connect(function()
            if stopped or socket ~= connection then
                return
            end
            pcall(function()
                connection:Close()
            end)
            socket = nil
            cancelAllJobs("disconnected")
        end)
    end
    return true
end

local function tryWebSocket()
    if endpoint:sub(1, 4) == "http" then
        return false
    end
    for index = 1, 4 do
        local connector = websocketConnectors[index]
        if stopped then
            return false
        end
        if connector then
            local connected, connection = pcall(connector, endpoint)
            if connected and attachSocket(connection) then
                transportName = "websocket"
                socket = connection
                sendJson(helloPayload())
                return true
            end
            if type(connection) == "table" or type(connection) == "userdata" then
                pcall(function()
                    connection:Close()
                end)
            end
        end
    end
    return false
end

local function runHttp()
    if not httpRequest then
        return false
    end
    transportName = "http"
    local ready = httpCall(helloPayload())
    if not ready or ready.type ~= "ready" then
        return false
    end
    while not stopped do
        local message = httpCall({ type = "poll", token = token, sessionId = sessionId })
        if not message then
            return true
        end
        if message.type == "request" or message.type == "cancel" then
            handleRequest(message, httpCall)
        elseif message.type ~= "idle" then
            return true
        end
    end
    return true
end

local function runFile()
    if not writeFile or not readFile then
        return false
    end
    transportName = "file"
    if makeFolder then
        pcall(makeFolder, filePollRoot)
    end
    if not fileWrite(toHostPath, HttpService:JSONEncode(helloPayload())) then
        return false
    end
    local lastAgent = ""
    local connected = false
    local idle = 0
    while not stopped do
        local contents = fileRead(toAgentPath)
        if contents and contents ~= lastAgent then
            lastAgent = contents
            idle = 0
            local message = decodeJson(contents)
            if message and message.type == "ready" then
                connected = true
            elseif message and (message.type == "request" or message.type == "cancel") then
                connected = true
                handleRequest(message, function(payload)
                    fileWrite(toHostPath, HttpService:JSONEncode(payload))
                end)
            end
        else
            idle += 0.2
            if not connected and idle > 5 then
                return false
            end
        end
        task.wait(0.2)
    end
    return true
end

local function connect()
    while not stopped do
        if tryWebSocket() then
            while socket and not stopped do
                task.wait(0.2)
            end
        elseif not runHttp() and not runFile() then
            task.wait(2)
        end
    end
end

local agent = {}

function agent.Stop()
    stopped = true
    local cancelled = cancelAllJobs("stopped")
    if socket then
        pcall(function()
            socket:Close()
        end)
        socket = nil
    end
    return cancelled
end

environment.RobloxClientMcpAgent = agent
if configuration.TestMode then
    return { handlers = handlers, handleRequest = handleRequest, sessionId = sessionId, limits = limits, capabilities = capabilities }
end
task.spawn(connect)
return agent
