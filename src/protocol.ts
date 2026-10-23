import { z } from "zod"

export const REQUEST_METHODS = [
  "listInstances",
  "listScripts",
  "readSource",
  "searchSource",
  "inspect",
  "validate",
  "eval",
] as const
const shortText = z.string().max(4096)
export const sessionIdSchema = z.string().min(1).max(128)
export const diagnosticSchema = z.object({
  code: z.enum([
    "resolution",
    "stale_reference",
    "capability_unavailable",
    "compile",
    "runtime",
    "busy",
    "invalid_request",
    "expired_cursor",
    "response_budget",
    "internal",
    "timeout",
    "cancelled",
  ]),
  message: shortText,
  details: shortText.optional(),
})
export const agentInfoSchema = z.object({
  agentVersion: z.string().min(1).max(32),
  sessionId: sessionIdSchema,
  placeId: z.number().int().nonnegative(),
  placeVersion: z.number().int().nonnegative().optional(),
  jobId: z.string().max(128),
  playerName: z.string().max(64),
  userId: z.number().int().nonnegative(),
  transport: z.enum(["websocket", "http", "file"]).optional(),
  executor: z
    .object({ name: z.string().max(64).optional(), version: z.string().max(64).optional() })
    .optional(),
  capabilities: z.record(z.string(), z.boolean()),
  limits: z.record(z.string(), z.number().nonnegative()),
})
export type AgentInfo = z.infer<typeof agentInfoSchema>
export const helloMessageSchema = z.object({
  type: z.literal("hello"),
  token: z.string().min(32).max(256),
  agent: agentInfoSchema,
})
export const pollMessageSchema = z.object({
  type: z.literal("poll"),
  token: z.string().min(32).max(256),
  sessionId: sessionIdSchema,
})
export const responseMessageSchema = z.discriminatedUnion("ok", [
  z.object({
    type: z.literal("response"),
    id: z.string().min(1).max(64),
    sessionId: sessionIdSchema,
    ok: z.literal(true),
    result: z.json(),
  }),
  z.object({
    type: z.literal("response"),
    id: z.string().min(1).max(64),
    sessionId: sessionIdSchema,
    ok: z.literal(false),
    error: diagnosticSchema,
  }),
])
export type RequestMethod = (typeof REQUEST_METHODS)[number]
export const requestMessageSchema = z.object({
  type: z.literal("request"),
  id: z.string().min(1).max(64),
  sessionId: sessionIdSchema,
  method: z.enum(REQUEST_METHODS),
  params: z.record(z.string(), z.unknown()),
  timeoutMs: z.number().int().positive().optional(),
})
export type AgentRequest = z.infer<typeof requestMessageSchema>
export type AgentCommand = AgentRequest | { type: "cancel"; id: string; sessionId: string }
export type AgentResponse = z.infer<typeof responseMessageSchema>
export type HttpAgentResponse = AgentResponse & { readonly token: string }
export function parseHttpAgentResponse(raw: unknown): HttpAgentResponse | undefined {
  if (typeof raw !== "object" || raw === null || !("token" in raw)) return undefined
  const token = raw.token
  if (typeof token !== "string" || token.length < 32 || token.length > 256) return undefined
  const parsed = responseMessageSchema.safeParse(raw)
  return parsed.success ? { ...parsed.data, token } : undefined
}

export const instanceSchema = z.object({
  ref: shortText,
  name: shortText,
  className: shortText,
  path: shortText,
  childCount: z.number().int().nonnegative().optional(),
  childCountError: shortText.optional(),
  isScript: z.boolean(),
  match: z.enum(["inventory", "exact_name", "name_prefix", "name", "path"]).optional(),
  stale: z.boolean().optional(),
})
const getterSchema = z.object({
  source: z.string(),
  status: z.enum(["ok", "unavailable", "failed"]),
  count: z.number().int().nonnegative().optional(),
  error: shortText.optional(),
})
const coverageSchema = z.object({
  complete: z.boolean(),
  scanned: z.number().int().nonnegative(),
  limitReached: z.boolean(),
  sources: z.array(getterSchema),
})
const listingFields = {
  total: z.number().int().nonnegative(),
  returned: z.number().int().nonnegative(),
  scope: z.string(),
  query: z.string(),
  nextCursor: shortText.optional(),
  coverage: coverageSchema,
}
export const instancesResultSchema = z.object({
  ...listingFields,
  children: z.array(instanceSchema),
  instance: instanceSchema.optional(),
  className: z.string().optional(),
})
export const scriptsResultSchema = z.object({ ...listingFields, scripts: z.array(instanceSchema) })
const recoveryFields = {
  ref: shortText,
  path: shortText,
  className: shortText,
  cache: z.enum(["hit", "miss", "refreshed"]),
  failures: z.array(
    z.object({
      method: z.string(),
      status: z.enum(["unavailable", "failed"]),
      error: shortText.optional(),
    }),
  ),
}
export const sourceResultSchema = z.discriminatedUnion("kind", [
  z.object({
    ...recoveryFields,
    kind: z.literal("luau"),
    provenance: z.literal("decompiled"),
    data: z.string(),
    startLine: z.number().int(),
    endLine: z.number().int(),
    totalLines: z.number().int(),
    startColumn: z.number().int(),
    nextColumn: z.number().int().optional(),
    lineTruncated: z.boolean().optional(),
    truncated: z.boolean(),
    nextLine: z.number().int().optional(),
  }),
  z.object({
    ...recoveryFields,
    kind: z.literal("bytecode"),
    provenance: z.literal("bytecode"),
    data: z.string(),
    byteOffset: z.number().int(),
    totalBytes: z.number().int(),
    byteCount: z.number().int(),
    truncated: z.boolean(),
    nextByteOffset: z.number().int().optional(),
  }),
  z.object({
    ...recoveryFields,
    kind: z.literal("constants"),
    provenance: z.literal("constants"),
    data: z.json(),
    truncated: z.boolean().optional(),
  }),
  z.object({ ...recoveryFields, kind: z.literal("unavailable"), provenance: z.literal("none") }),
])
export const searchResultSchema = z.object({
  matches: z.array(
    z.object({
      ref: shortText,
      path: shortText,
      provenance: z.enum(["decompiled", "constants"]),
      line: z.number().int().positive().optional(),
      excerpt: shortText,
    }),
  ),
  coverage: z.object({
    complete: z.boolean(),
    searched: z.number().int().nonnegative(),
    candidates: z.number().int().nonnegative(),
    remaining: z.number().int().nonnegative(),
    unavailable: z.number().int().nonnegative(),
    inventory: z.object({ complete: z.boolean() }).passthrough(),
    matchLimitReached: z.boolean(),
  }),
  nextCursor: shortText.optional(),
  mode: z.enum(["cached", "expand"]),
  query: z.string(),
})
const fieldResultSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), value: z.json() }),
  z.object({ ok: z.literal(false), error: shortText }),
])
export const inspectResultSchema = z.object({
  ref: shortText,
  path: shortText,
  className: shortText,
  properties: z.record(z.string(), fieldResultSchema),
  attributes: fieldResultSchema.optional(),
  tags: fieldResultSchema.optional(),
  ancestry: z.array(z.object({ ref: shortText, name: shortText, className: shortText })).optional(),
  ancestryTruncated: z.boolean().optional(),
  truncated: z.boolean().optional(),
})
export const validateResultSchema = z.discriminatedUnion("valid", [
  z.object({ valid: z.literal(true) }),
  z.object({ valid: z.literal(false), diagnostic: diagnosticSchema }),
])
export const evalResultSchema = z.object({
  values: z.array(z.json()),
  count: z.number().int().nonnegative(),
  returned: z.number().int().nonnegative(),
  truncated: z.boolean().optional(),
})
export const resultSchemas = {
  listInstances: instancesResultSchema,
  listScripts: scriptsResultSchema,
  readSource: sourceResultSchema,
  searchSource: searchResultSchema,
  inspect: inspectResultSchema,
  validate: validateResultSchema,
  eval: evalResultSchema,
} as const
export const statusResultSchema = z.object({
  connected: z.boolean(),
  agent: agentInfoSchema.optional(),
})

// SDK 1.29 requires an object at the root of outputSchema. The wire results above
// retain discriminated unions; these object projections advertise every variant
// field and are additionally checked against the union before returning content.
export const outputSchemas = {
  ...resultSchemas,
  readSource: z.object({
    ...recoveryFields,
    kind: z.enum(["luau", "bytecode", "constants", "unavailable"]),
    provenance: z.enum(["decompiled", "bytecode", "constants", "none"]),
    data: z.json().optional(),
    startLine: z.number().int().optional(),
    endLine: z.number().int().optional(),
    totalLines: z.number().int().optional(),
    startColumn: z.number().int().optional(),
    nextColumn: z.number().int().optional(),
    lineTruncated: z.boolean().optional(),
    truncated: z.boolean().optional(),
    nextLine: z.number().int().optional(),
    byteOffset: z.number().int().optional(),
    byteCount: z.number().int().optional(),
    totalBytes: z.number().int().optional(),
    nextByteOffset: z.number().int().optional(),
  }),
  validate: z.object({ valid: z.boolean(), diagnostic: diagnosticSchema.optional() }),
}
