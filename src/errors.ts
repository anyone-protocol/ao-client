// Error taxonomy. Kept in its own module so `wire.ts` can raise validation errors
// without importing `client.ts` (which imports wire) and creating a cycle.
//
// The distinctions here are not cosmetic — they drive the retry policy. Repeating
// a deterministic failure wastes time and buries the real message under three
// identical log lines.

/** Any non-2xx node response. Carries the status so retries can be selective. */
export class AoHttpError extends Error {
  constructor (
    readonly status: number,
    readonly method: string,
    readonly path: string,
    readonly body: string
  ) {
    super(`${method} ${path} -> ${status}: ${body.replace(/\s+/g, ' ').slice(0, 300)}`)
    this.name = 'AoHttpError'
  }
}

/** A read whose target key does not exist. Distinct from a transport failure. */
export class AoNotFoundError extends Error {
  constructor (readonly path: string) {
    super(`ao-client: not found: ${path}`)
    this.name = 'AoNotFoundError'
  }
}

/** Caller-side misuse (bad tags, missing config). Never retried — it cannot improve. */
export class AoValidationError extends Error {
  constructor (message: string) {
    super(`ao-client: ${message}`)
    this.name = 'AoValidationError'
  }
}

/**
 * The message was scheduled and computed, and the CONTRACT rejected it.
 *
 * This is the failure mode that does not look like one: a rejected write still
 * returns HTTP 200 with a signed assignment, because the push succeeded — only the
 * compute failed. The reason appears solely in that slot's own output
 * (`error: <reason>`, runtime/native.lua). A client that trusts the HTTP status
 * reports success for a write that changed nothing, which is exactly the class of
 * silent failure this migration exists to eliminate.
 */
export class AoContractError extends Error {
  constructor (
    readonly reason: string,
    readonly processId: string,
    readonly slot: string,
    readonly action?: string
  ) {
    super(`ao-client: contract rejected ${action ?? 'message'} at slot ${slot}: ${reason}`)
    this.name = 'AoContractError'
  }
}

/**
 * Only transport-level failures are worth repeating. A 4xx, a missing key, a
 * malformed tag and a contract rejection are all deterministic.
 */
export const isRetryable = (e: unknown): boolean => {
  if (e instanceof AoValidationError) return false
  if (e instanceof AoNotFoundError) return false
  if (e instanceof AoContractError) return false
  if (e instanceof AoHttpError) return e.status >= 500 || e.status === 429
  return true
}
