export class BridgeUnavailableError extends Error {
  readonly name = "BridgeUnavailableError"
  readonly code = "disconnected"

  constructor() {
    super("No authenticated live client is connected")
  }
}

export class BridgeTimeoutError extends Error {
  readonly name = "BridgeTimeoutError"
  readonly code = "timeout"

  constructor(
    readonly requestId: string,
    readonly timeoutMs: number,
  ) {
    super(
      `Live client request ${requestId} timed out after ${timeoutMs}ms; cancellation is best effort and does not undo effects`,
    )
  }
}

export class AgentRequestError extends Error {
  readonly name = "AgentRequestError"
  readonly code: string
  readonly traceback: string | undefined

  constructor(
    readonly requestId: string,
    error: {
      readonly code: string
      readonly message: string
      readonly details?: string | undefined
    },
  ) {
    super(error.message)
    this.code = error.code
    this.traceback = error.details
  }
}

export class BridgeDisconnectedError extends Error {
  readonly name = "BridgeDisconnectedError"
  readonly code = "disconnected"

  constructor() {
    super("The live client disconnected before the request completed")
  }
}

export class BridgeBusyError extends Error {
  readonly name = "BridgeBusyError"
  readonly code = "busy"

  constructor() {
    super("The live client request queue is full; wait for pending work to finish")
  }
}

export class BridgeStartupError extends Error {
  readonly name = "BridgeStartupError"
}

export class BridgeCancelledError extends Error {
  readonly name = "BridgeCancelledError"
  readonly code = "cancelled"

  constructor() {
    super("The request was cancelled; cancellation is best effort and does not undo effects")
  }
}
