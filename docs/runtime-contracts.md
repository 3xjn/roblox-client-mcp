# Runtime contracts (protocol 0.2)

## Identity and discovery

Hello supplies `agent.sessionId`; request, cancel, poll and response messages carry that session ID. Every target row includes `ref`, `name`, `className`, `path` and `isScript`; discovery rows include a match explanation (`match`). Child counts are enriched only on returned rows; failures use `childCountError`, never a fabricated count. Resolve with exactly one `ref` or `path`. Missing, evicted, collected, or previous-agent references fail as `stale_reference`. Duplicate path segments fail as `resolution`.

Reference tables hold weak instance keys/values with a 10,000-entry FIFO handle cap. Replacing the live agent creates a new GUID namespace. Reconnection to that same agent preserves identity; replacing the host's active agent invalidates access to the previous session. Do not embed handles in persistent Luau.

Discovery orders exact name, name prefix, name substring, then path substring. Ties use case-folded path and the session reference. `all` includes the ordinary game tree, executor inventory and detached roots/descendants; script discovery additionally merges script getters. `children` means direct children of the explicit root or game. `nil` means `getnilinstances` roots plus descendants; it accepts no root. Explicit `all` roots include the root itself. `running`, `loaded`, `cached` mean only `getrunningscripts`, `getloadedmodules`, `getscripts` respectively, with no fallback.

Each source status is `ok` (including count 0), `unavailable`, or `failed` with bounded error. `coverage.complete` means all relevant sources succeeded and candidate processing was not capped. This is coverage of the client-visible inventory, never the server's entire game. Snapshot rows freeze membership, order and identifying metadata. Child counts are current enrichment; an expired instance is marked stale. Continue `nextCursor`; restart on `expired_cursor`. New cursor requests should contain only the cursor and page limit; other query inputs are ignored on continuation.

## Source evidence

`readSource` discriminates by `kind`: `luau`/`decompiled`, `constants`/`constants`, `bytecode`/`bytecode`, `unavailable`/`none`. Every result carries extraction `failures` (`method`, unavailable/failed status, bounded error) and `cache` (hit/miss/refreshed). Constants use bounded serialized values, not source lines. Routine source recovery attempts decompilation then closure constants; it does not dump bytecode. Empty/invalid/oversized decompilation is a failed attempt. Unsuccessful recovery is not cached.

`refresh:true` discards the applicable cached evidence and attempts recovery again. Bytecode is explicit and hexadecimal, with one-based `byteOffset`, actual `byteCount`, `totalBytes`, `truncated`, and optional `nextByteOffset`. Source uses one-based `startLine`/`startColumn`, `endLine`, `totalLines`, `truncated`, optional `nextLine`/`nextColumn`. Pass both continuation coordinates when a long line is split. An empty out-of-range page has no continuation. Do not assume decompiled text equals authored source.

`searchSource` performs a case-sensitive literal search (identifier strings work without regex). `cached` examines only retained source/constant evidence. `expand` recovers evidence for explicit refs or a selected script scope. A continuation freezes the candidate set and query, and retains searched evidence up to 2 MiB per snapshot. This is recovered evidence, not a versioned game snapshot. `coverage` reports searched this call, candidates, remaining, unavailable, inventory coverage, match-limit state and completeness. Failed retrievals and expired refs leave coverage partial. Only decompiled matches have `line`; constants have provenance and excerpts without line numbers. Continue `nextCursor` until exhausted. Cache-only results remain partial relative to runtime inventory even when no cache candidates remain.

## Inspection, validation and execution

Inspection accepts 1–20 explicit properties and optional attributes, tags and ancestry. Each property/attribute/tag result is `{ok:true,value}` or `{ok:false,error}`. Ancestry is limited to 16 entries and explicitly marks truncation. Modules are never executed for inspection. Serialized values preserve nil and non-finite numbers through tagged objects, tables through bounded entries, cycles through a marker, and instances through refs.

Validation returns `{valid:true}` or `{valid:false,diagnostic}` after compilation only. Eval returns `values`, total `count`, `returned`, and `truncated`; tagged nil preserves return positions. Compilation establishes syntax; execution establishes only completion of the submitted chunk; behavior requires an assertion or relevant observation. Async callbacks are outside synchronous completion.

The host serializes dispatch across all MCP clients and permits at most eight pending requests. Abort/timeout removes queued work and attempts to cancel dispatched work. It retains ownership until a response/cancellation acknowledgement or disconnect. The agent keeps eval ownership if task cancellation fails. Cancellation cannot roll back mutations or reliably interrupt non-yielding native/executor work. A replacement agent refuses to start if the previous agent reports uncancelled jobs. Error codes distinguish resolution, stale reference, capability availability, compile, runtime, busy, timeout, cancelled, invalid request, expired cursor, response budget and internal errors; host disconnection is separate. Runtime errors preserve a bounded traceback captured inside the failing stack.

## Limits and costs

| Limit | Value |
| --- | --- |
| Live response, including envelope | 32,768 JSON bytes |
| List page | 50 default, 200 maximum; may shrink for byte budget |
| Candidate processing per inventory | 5,000 entries (including duplicates across getters) |
| Retained snapshots | 8, 60 seconds each; last 256 issued continuation tokens per snapshot |
| Weak reference handles | 10,000 FIFO |
| Recovered source cache | 64 entries, 2 MiB total; 256 KiB per extraction |
| Source page | 100 lines default, 500 maximum; 4,000 raw-byte budget with column continuation |
| Bytecode page | 1,024 bytes default, 4,096 maximum |
| Search per call | 5 scripts default, 20 maximum; 20 matches default, 50 maximum |
| Inspection | 20 properties, 16 ancestors |
| Serialized values | depth 6, 100 entries/table, shared conservative byte budget |

Work yields between inventory batches and source-search units. Getter, compiler and decompiler calls themselves are executor primitives and cannot be incrementally budgeted; obtaining a whole inventory/text may allocate beyond the retained/processed budget. Oversized extraction is rejected rather than retained. Expired snapshots are cleaned when new snapshots are made and are always capped. All successful wire responses are measured before sending; overflow is an explicit `response_budget` error with guidance to request smaller output. Smaller list pages and source coordinates allow expansion. Serialized eval/inspection truncation does not offer replay continuation.

MCP outputs are compact text plus checked structured content, which duplicates payload data in clients that consume both. `outputSchema` uses SDK-supported root objects; source/validation discriminated unions are additionally checked before returning. Structured output improves contract checking, not an assumed token saving. Benchmark reports measure text and structured bytes separately; tokens require a specified tokenizer/model and are not inferred from character count.
