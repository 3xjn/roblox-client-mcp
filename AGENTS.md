# roblox-client-mcp

Live Roblox **client** inspector, not Studio. Loopback is `127.0.0.1` only — never `localhost`.

Executor-agnostic: require `loadstring` and `getgenv`. Capability-detect UNC/sUNC globals. Never branch on `identifyexecutor()`.

Executors have a **workspace** (`readfile`/`writefile` cwd) and often **autoexec** (runs on inject). Typical Windows:

- Volt: `%LOCALAPPDATA%\Volt\workspace` and `autoexec`
- Potassium: `%LOCALAPPDATA%\Potassium\workspace`

`agent.lua` is loaded from that workspace. Default live URL is `ws://127.0.0.1:32145/live`. HTTP MCP is port `32146` at `/mcp`, same token.

First-time connect or persist-on-inject: [skills/live-client-setup/SKILL.md](skills/live-client-setup/SKILL.md).
