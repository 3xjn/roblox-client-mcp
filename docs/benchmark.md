# Repeatable validation and evaluation

Run `bun install --frozen-lockfile`, `bun run check`, and `bun run scripts/benchmark.ts`.
The syntax gate compiles the unmodified `agent.lua` with `luau-web@1.5.1` without
executing it. The behavioral tests execute that same file in Luau WASM with a small
Instance tree and executor capability fixture. The fixture supplies Roblox services,
deterministic clock/IDs, compilation, and JSON serialization (including empty tables
as arrays). It does not reimplement discovery, references, recovery, pagination,
serialization, execution, or validation algorithms.

## Offline measurements

The benchmark starts each task in a fresh fixture, follows a prescribed workflow,
and asserts the requested evidence/result. These are handler-level regression
measurements, **not model-agent results or live Roblox timings**. Returned bytes are
the UTF-8-equivalent JSON bytes for these ASCII fixture handler results, summed once
per call, including diagnostics. They exclude MCP text/structured-content wrappers
and transport envelopes. Elapsed time includes the workflow's Luau execution and
WASM/host crossings, excluding fixture initialization. Tokens are unavailable.
Unnecessary evals are zero by construction; retries count the explicit repair in task 6.

Measured on 2026-10-23, Windows, Bun 1.3.4, luau-web 1.5.1:

| Task | Success / correct evidence | Calls | Evals | Retries | Returned bytes | Elapsed ms |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| Generic script: find literal and cite line 2 | yes / yes | 2 | 0 | 0 | 984 | 6.822 |
| Duplicate names: select the source returning 99 | yes / yes | 4 | 0 | 0 | 1,680 | 4.154 |
| Unparented script: source and nil Parent | yes / yes | 3 | 0 | 0 | 1,064 | 3.590 |
| Unavailable inventory/source: preserve uncertainty | yes / yes | 4 | 0 | 0 | 1,263 | 2.707 |
| Compile change and assert double(21) == 42 | yes / yes | 2 | 1 | 0 | 70 | 1.657 |
| Repair nil indexing from runtime diagnostics | yes / yes | 3 | 2 | 1 | 416 | 3.303 |

No before/after performance improvement is claimed. Reruns report current values;
timings vary with host load.

## Actual MCP response cost samples

The same benchmark also sends two real fixture results through `createMcpServer`
and the SDK's `InMemoryTransport` to a real MCP `Client.callTool`. These measurements
include the server's result validation and the actual returned text and structured
content. The source sample reads the generic script; the nested eval sample returns
a table containing nested settings, an array, and a second nil result.

| Sample | Handler JSON bytes | Text bytes | Structured JSON bytes | Text + structured bytes | Whole CallToolResult JSON bytes | MCP call ms |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Recovered source | 333 | 333 | 333 | 666 | 775 | 11.839 |
| Nested eval | 412 | 412 | 412 | 824 | 964 | 26.811 |

Measured in the same environment on 2026-10-23. These are UTF-8 byte counts from
the actual SDK result. The whole-result figure includes escaped strings and
CallToolResult fields, but excludes the outer JSON-RPC message envelope. Text plus
structured content measures potential context duplication if a client supplies
both representations to its model; it does not establish what a particular client
actually includes. In these samples, returning both doubles payload content bytes.
This is a measured cost of the checked contract, not a token-reduction claim. Model
tokens remain unavailable. MCP call timing excludes fixture creation and initial
MCP connection, and includes the local in-memory round trip, not Roblox transport.

## Live model comparison procedure

A live executor was available for the isolated smoke checks below. The remaining gap is a full production transport/executor run of the new agent plus an autonomous model runner. To measure
agent effectiveness, use the same model/version, settings, tool budgets, prompts,
and fresh fixture state for each revision. Record the revision and model identifiers.
Create the tree matching `tests/lua-fixture.ts` in a disposable test place; keep the
two `Duplicate` siblings, generic `Script`, detached module, and detached ancestor.
Load the corresponding revision's agent through the supported setup workflow. Do
not substitute persistent diagnostic refs between runs. For unavailable-capability
task 4, omit the running getter and both source recovery capabilities before loading.

Give the runner these six prompts separately with fresh state:

1. “Find the script containing `target_behavior`. Cite the relevant source line and explain what it returns.”
2. “Find both scripts named `Duplicate`. Select and inspect the exact one whose source returns speed 99.”
3. “Find the unparented `Detached` script, inspect its Parent, and recover its source.”
4. “Determine whether any running scripts contain `absent`. Report exactly what the available evidence establishes.”
5. “Write a local function that doubles an argument, check its syntax, then verify that double(21) equals 42 with an assertion.”
6. “Execute `local value=nil; return value.total`, use its diagnostics to repair the chunk to return 42, then verify the repaired behavior.”

For each run, save every actual MCP tool response and timestamp. Record task success,
correct target/evidence (against the fixture), total tool calls, unnecessary evals,
retries, summed response UTF-8 bytes, model input/output tokens when supplied by the
runner, and total wall-clock time. Count the bytes actually supplied to the model,
including both text and structured content when both are included. Grade task 4 as
incorrect if it claims absence from unavailable/partial evidence. Grade task 5 only
when an executed assertion or relevant observation verifies the result; compilation
alone is insufficient. Repeat each task with both revisions in alternating order.

Live model tasks, real-client context token costs, executor capability behavior, and
cross-executor integration were not measured by the offline harness.

## Live isolated smoke validation

On 2026-10-23, the new `agent.lua` was compiled and loaded in the connected Roblox client's executor inside an isolated environment (`TestMode=true`). It used real temporary ModuleScript/Folder Instances and the real executor compiler, with deterministic fixture inventory and source getters. The existing agent was not replaced and remained connected. Every temporary Instance was destroyed after the test.

Ten checks passed: distinct duplicate references; stable two-page discovery; nil Parent inspection; unparented source retrieval; detached-descendant discovery; exact-ref source search with line evidence; compile-only validation without invocation; invalid syntax diagnostics; multiple returns with nil positions; and runtime error/traceback diagnostics. The loader compiled the actual current `agent.lua` (about 55 KB including the smoke wrapper).

This smoke check does not establish that a production executor's decompiler or inventory getters are complete/correct, nor that new-agent WebSocket/HTTP/file fallback behaves correctly in that executor. Offline integration tests cover all three transports with controlled peers; the production live host still runs its earlier agent revision. No model comparison or token measurement was performed.
