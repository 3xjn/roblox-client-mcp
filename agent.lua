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
    for _, connector in ipairs(websocketConnectors) do
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
    environment.RobloxClientMcpAgent.Stop()
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
            local child = current:FindFirstChild(name)
            if not child then
                return nil, ('Could not resolve "%s"'):format(name)
            end
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
            local child = current:FindFirstChild(name)
            if not child then
                return nil, ('Could not resolve "%s"'):format(name)
            end
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
        root = "game"
    end
    return root .. table.concat(segments)
end

local function describeInstance(instance)
    local childCount = 0
    local succeeded, children = pcall(instance.GetChildren, instance)
    if succeeded then
        childCount = #children
    end
    return {
        name = instance.Name,
        className = instance.ClassName,
        path = getInstancePath(instance),
        childCount = childCount,
        isScript = instance:IsA("LuaSourceContainer") and not instance:IsA("CoreScript"),
    }
end

local function serialize(value, depth, seen)
    local valueType = typeof(value)
    if value == nil then
        return { type = "nil" }
    end
    if valueType == "boolean" or valueType == "string" then
        return value
    end
    if valueType == "number" then
        if value ~= value or value == math.huge or value == -math.huge then
            return { type = "number", value = tostring(value) }
        end
        return value
    end
    if valueType == "Instance" then
        return {
            type = "Instance",
            className = value.ClassName,
            name = value.Name,
            path = getInstancePath(value),
        }
    end
    if valueType ~= "table" then
        return { type = valueType, value = tostring(value) }
    end
    if depth >= 6 then
        return { type = "table", truncated = true, reason = "depth" }
    end
    if seen[value] then
        return { type = "table", circular = true }
    end

    seen[value] = true
    local entries = {}
    local count = 0
    local truncated = false
    for key, child in next, value do
        count += 1
        if count > 200 then
            truncated = true
            break
        end
        table.insert(entries, {
            key = serialize(key, depth + 1, seen),
            value = serialize(child, depth + 1, seen),
        })
    end
    seen[value] = nil
    return { type = "table", entries = entries, truncated = truncated }
end

local function callList(getter)
    if not getter then
        return nil
    end
    local succeeded, values = pcall(getter)
    if succeeded and type(values) == "table" then
        return values
    end
    return nil
end

local function collectAllInstances()
    local instances = callList(getAllInstances)
    local nils = callList(getNilInstances)
    if instances or nils then
        local seen = {}
        local values = {}
        for _, list in ipairs({ instances or {}, nils or {} }) do
            for _, instance in ipairs(list) do
                if typeof(instance) == "Instance" and not seen[instance] then
                    seen[instance] = true
                    table.insert(values, instance)
                end
            end
        end
        return values
    end
    local descendants = game:GetDescendants()
    table.insert(descendants, 1, game)
    return descendants
end

local function isScriptInstance(instance)
    return typeof(instance) == "Instance"
        and instance:IsA("LuaSourceContainer")
        and not instance:IsA("CoreScript")
end

local function collectByClass()
    local scripts = {}
    for _, instance in ipairs(collectAllInstances()) do
        if isScriptInstance(instance) then
            table.insert(scripts, instance)
        end
    end
    return scripts
end

local function appendScripts(scripts, seen, getter)
    local values = callList(getter)
    if not values then
        return false
    end
    for _, instance in ipairs(values) do
        if isScriptInstance(instance) and not seen[instance] then
            seen[instance] = true
            table.insert(scripts, instance)
        end
    end
    return true
end

local function collectScripts(scope)
    local scripts = {}
    local seen = {}

    if scope == "running" then
        if appendScripts(scripts, seen, getRunningScripts) then
            return scripts
        end
        return collectByClass()
    end
    if scope == "loaded" then
        if appendScripts(scripts, seen, getLoadedModules) then
            return scripts
        end
        return collectByClass()
    end
    if appendScripts(scripts, seen, getCachedScripts) then
        if scope == "all" then
            appendScripts(scripts, seen, getRunningScripts)
            appendScripts(scripts, seen, getLoadedModules)
        end
        return scripts
    end
    return collectByClass()
end

local function hexEncode(data)
    return (string.gsub(data, ".", function(character)
        return string.format("%02x", string.byte(character))
    end))
end

local function pageSource(source, startLine, lineCount)
    local lines = {}
    for line in (source .. "\n"):gmatch("(.-)\n") do
        table.insert(lines, line)
    end
    startLine = math.clamp(tonumber(startLine) or 1, 1, math.max(#lines, 1))
    lineCount = math.clamp(tonumber(lineCount) or 1000, 1, 5000)
    local endLine = math.min(startLine + lineCount - 1, #lines)
    local page = {}
    for index = startLine, endLine do
        table.insert(page, lines[index])
    end
    return table.concat(page, "\n"), startLine, endLine, #lines, endLine < #lines
end

local function readConstants(instance)
    if not getScriptClosure or not getConstants then
        return nil
    end
    local gotClosure, closure = pcall(getScriptClosure, instance)
    if not gotClosure or type(closure) ~= "function" then
        return nil
    end
    local gotConstants, constants = pcall(getConstants, closure)
    if not gotConstants or type(constants) ~= "table" then
        return nil
    end
    return constants
end

local function filterInstances(values, query, className, limit, parent)
    local matches = {}
    query = string.lower(query or "")
    className = className or ""
    for _, instance in ipairs(values) do
        if typeof(instance) == "Instance"
            and (className == "" or instance.ClassName == className)
            and (not parent or instance == parent or instance:IsDescendantOf(parent))
        then
            local described = describeInstance(instance)
            if query == ""
                or string.find(string.lower(described.path), query, 1, true)
                or string.find(string.lower(described.name), query, 1, true)
            then
                table.insert(matches, described)
            end
        end
    end
    table.sort(matches, function(left, right)
        return string.lower(left.path) < string.lower(right.path)
    end)
    local total = #matches
    while #matches > limit do
        table.remove(matches)
    end
    return matches, total
end

local sourceCache = setmetatable({}, { __mode = "k" })
local handlers = {}

function handlers.listInstances(params)
    local scope = params.scope or "children"
    local query = params.query or ""
    local className = params.className or ""
    local limit = math.clamp(tonumber(params.limit) or 200, 1, 1000)
    local listed
    local values
    local descendantOf

    if scope == "nil" then
        values = callList(getNilInstances)
        if not values then
            values = {}
            for _, instance in ipairs(collectAllInstances()) do
                if typeof(instance) == "Instance" and instance.Parent == nil then
                    table.insert(values, instance)
                end
            end
        end
    elseif scope == "all" then
        if params.path then
            local instance, resolveError = resolvePath(params.path)
            if not instance then
                error(resolveError)
            end
            listed = instance
            descendantOf = instance
        end
        values = collectAllInstances()
    else
        local instance, resolveError = resolvePath(params.path or "game")
        if not instance then
            error(resolveError)
        end
        listed = instance
        values = instance:GetChildren()
    end

    local matches, total = filterInstances(values, query, className, limit, descendantOf)
    return {
        scope = scope,
        instance = listed and describeInstance(listed) or nil,
        children = matches,
        total = total,
        returned = #matches,
        query = string.lower(query),
        className = className,
    }
end

function handlers.listScripts(params)
    local scope = params.scope or "all"
    if scope ~= "all" and scope ~= "running" and scope ~= "loaded" and scope ~= "cached" then
        error("Invalid script scope")
    end

    local query = string.lower(params.query or "")
    local limit = math.clamp(tonumber(params.limit) or 200, 1, 1000)
    local matches = {}
    for _, instance in ipairs(collectScripts(scope)) do
        local path = getInstancePath(instance)
        if query == "" or string.find(string.lower(path), query, 1, true) then
            table.insert(matches, {
                name = instance.Name,
                className = instance.ClassName,
                path = path,
            })
        end
    end
    table.sort(matches, function(left, right)
        return string.lower(left.path) < string.lower(right.path)
    end)

    local total = #matches
    while #matches > limit do
        table.remove(matches)
    end
    return { scripts = matches, total = total, returned = #matches, scope = scope, query = query }
end

function handlers.readSource(params)
    local instance, resolveError = resolvePath(params.path)
    if not instance then
        error(resolveError)
    end
    if not instance:IsA("LuaSourceContainer") or instance:IsA("CoreScript") then
        error(("Path resolves to %s, not a script"):format(instance.ClassName))
    end

    local cached = sourceCache[instance]
    if not cached then
        if decompileSource then
            local succeeded, source = pcall(decompileSource, instance)
            if succeeded and type(source) == "string" and #source > 0 then
                cached = { kind = "luau", data = source }
            end
        end
        if not cached and dumpBytecode then
            local succeeded, bytecode = pcall(dumpBytecode, instance)
            if succeeded and type(bytecode) == "string" and #bytecode > 0 then
                cached = { kind = "bytecode", data = bytecode }
            end
        end
        if not cached then
            local constants = readConstants(instance)
            if constants then
                cached = { kind = "constants", data = constants }
            else
                cached = { kind = "empty", data = "" }
            end
        end
        sourceCache[instance] = cached
    end

    local path = getInstancePath(instance)
    if cached.kind == "luau" then
        local source, startLine, endLine, totalLines, truncated = pageSource(
            cached.data,
            params.startLine,
            params.lineCount
        )
        return {
            path = path,
            className = instance.ClassName,
            kind = "luau",
            data = source,
            startLine = startLine,
            endLine = endLine,
            totalLines = totalLines,
            truncated = truncated,
        }
    end
    if cached.kind == "bytecode" then
        return {
            path = path,
            className = instance.ClassName,
            kind = "bytecode",
            data = hexEncode(cached.data),
        }
    end
    return {
        path = path,
        className = instance.ClassName,
        kind = cached.kind,
        data = cached.data,
    }
end

function handlers.eval(params)
    local chunk, compileError = compile(params.code, params.chunkName or "roblox-client-mcp")
    if not chunk then
        error(compileError)
    end

    local results = table.pack(pcall(chunk))
    if not results[1] then
        error(results[2])
    end
    local values = {}
    for index = 2, results.n do
        table.insert(values, serialize(results[index], 0, {}))
    end
    return { values = values, count = results.n - 1 }
end

local stopped = false
local socket
local inFlight = 0
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
            agentVersion = "0.1.1",
            placeId = game.PlaceId,
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
    local payload
    if succeeded then
        local encoded, encodeError = pcall(HttpService.JSONEncode, HttpService, value)
        if not encoded then
            payload = { type = "response", id = id, ok = false, error = tostring(encodeError) }
        else
            payload = { type = "response", id = id, ok = true, result = value }
        end
    else
        payload = {
            type = "response",
            id = id,
            ok = false,
            error = tostring(value):sub(1, 4096),
        }
    end
    payload.token = token
    sendJson(payload)
    return payload
end

local function handleRequest(request)
    if type(request) ~= "table" or request.type ~= "request" then
        return
    end
    if type(request.id) ~= "string" or type(request.method) ~= "string" then
        return
    end
    local handler = handlers[request.method]
    if not handler then
        return respond(request.id, false, "Unknown method: " .. request.method)
    end
    if inFlight >= 8 then
        return respond(request.id, false, "Too many live requests")
    end

    inFlight += 1
    local succeeded, result = pcall(handler, request.params or {})
    inFlight -= 1
    return respond(request.id, succeeded, result)
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
        end)
    end
    return true
end

local function tryWebSocket()
    if endpoint:sub(1, 4) == "http" then
        return false
    end
    for _, connector in ipairs(websocketConnectors) do
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
        local message = httpCall({ type = "poll", token = token })
        if not message then
            return true
        end
        if message.type == "request" then
            local payload = handleRequest(message)
            if payload then
                httpCall(payload)
            end
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
            elseif message and message.type == "request" then
                connected = true
                local payload = handleRequest(message)
                if payload then
                    fileWrite(toHostPath, HttpService:JSONEncode(payload))
                end
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
    if socket then
        pcall(function()
            socket:Close()
        end)
        socket = nil
    end
end

environment.RobloxClientMcpAgent = agent
task.spawn(connect)
return agent
