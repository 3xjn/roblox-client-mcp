import { z } from "zod"

export const REQUEST_METHODS = ["listInstances", "listScripts", "readSource", "eval"] as const

export const agentInfoSchema = z.object({
  agentVersion: z.string().min(1).max(32),
  placeId: z.number().int().nonnegative(),
  jobId: z.string().max(128),
  playerName: z.string().max(64),
  userId: z.number().int().nonnegative(),
  transport: z.enum(["websocket", "http", "file"]).optional(),
  executor: z
    .object({
      name: z.string().max(64).optional(),
      version: z.string().max(64).optional(),
    })
    .optional(),
  capabilities: z.record(z.string(), z.boolean()).optional(),
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
})

export const responseMessageSchema = z.discriminatedUnion("ok", [
  z.object({
    type: z.literal("response"),
    id: z.string().min(1).max(64),
    ok: z.literal(true),
    result: z.json(),
  }),
  z.object({
    type: z.literal("response"),
    id: z.string().min(1).max(64),
    ok: z.literal(false),
    error: z.string().min(1).max(4096),
  }),
])

export type RequestMethod = (typeof REQUEST_METHODS)[number]

export const requestMessageSchema = z.object({
  type: z.literal("request"),
  id: z.string().min(1).max(64),
  method: z.enum(REQUEST_METHODS),
  params: z.record(z.string(), z.unknown()),
  timeoutMs: z.number().int().positive().optional(),
})

export type AgentRequest = z.infer<typeof requestMessageSchema>
export type AgentCommand = AgentRequest | { type: "cancel"; id: string }
export type AgentResponse = z.infer<typeof responseMessageSchema>
export type HttpAgentResponse = AgentResponse & { readonly token: string }

export function parseHttpAgentResponse(raw: unknown): HttpAgentResponse | undefined {
  if (typeof raw !== "object" || raw === null || !("token" in raw)) {
    return undefined
  }
  const token = raw.token
  if (typeof token !== "string" || token.length < 32 || token.length > 256) {
    return undefined
  }
  const parsed = responseMessageSchema.safeParse(raw)
  return parsed.success ? { ...parsed.data, token } : undefined
}
