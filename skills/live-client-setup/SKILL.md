---
name: Live client setup
description: Use this when connecting a live Roblox client to roblox-client-mcp, copying agent.lua, writing autoexec, or finding Volt/Potassium user folders. Not for ordinary code changes.
---

# Live client setup

## Default flow

1. Start with `bun start`, or let Cursor spawn the MCP over stdio. Do not do both.
2. Stderr prints the token and a Lua snippet. Stdout is MCP — the token is never there.
3. Copy `agent.lua` into the executor workspace.
4. Load/paste the snippet in the live client.

If `ROBLOX_CLIENT_MCP_PORT` is not `32145`, set `Url = ws://127.0.0.1:$PORT/live` in the snippet. Loopback is `127.0.0.1`, not `localhost`. Do not branch on `identifyexecutor`.

## Persist (optional)

If the user wants the snippet on every inject, put that same snippet in autoexec. Do not silently overwrite an existing autoexec file unless they asked to persist.

## Windows folders (verified)

- Volt: `%LOCALAPPDATA%\Volt\workspace` is what `readfile("agent.lua")` sees. `%LOCALAPPDATA%\Volt\autoexec` runs on inject.
- Potassium: `%LOCALAPPDATA%\Potassium\workspace` (observed). Do not claim a Potassium autoexec path. If the executor has autoexec, it is usually a sibling `autoexec` folder next to `workspace`.
