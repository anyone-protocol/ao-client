import type { Signer } from '@dha-team/arbundles/web'

/** An ANS-104 tag. Names must be unique and all-lowercase — see `wire.ts`. */
export interface Tag {
  name: string
  value: string
}

/**
 * Where to talk and who signs.
 *
 * `url` has NO default, deliberately. The AO legacynet outage that forced this
 * migration was caused by silent third-party defaults: nothing ever set MU_URL,
 * two services read a public CU, and deploy.ts carried hardcoded fallbacks. Every
 * endpoint in this package is explicit or it throws. Do not add a default.
 */
export interface AoConfig {
  /** Node base URL, e.g. https://hb.anyone.tech. Required; never defaulted. */
  url: string
  /** arbundles Signer. Node: `EthereumSigner`. Browser: `InjectedEthereumSigner`. */
  signer?: Signer
  /** Per-request timeout in ms (default 60_000). */
  timeoutMs?: number
  /** Attempts for transient failures (default 3). Writes retry only when safe. */
  retries?: number
  /** Optional sink for diagnostics; defaults to silence. */
  logger?: Logger
}

export interface Logger {
  debug?(message: string, ...meta: unknown[]): void
  warn?(message: string, ...meta: unknown[]): void
  error?(message: string, ...meta: unknown[]): void
}

/** A config whose signer is known to be present — the write paths require it. */
export type SigningConfig = AoConfig & { signer: Signer }

export interface SpawnOptions {
  /** Id of a lua module already readable by the node (published + cached). */
  moduleId?: string
  /** Inline lua source. Mutually exclusive with `moduleId`; see `spawnProcess`. */
  luaSource?: string
  /** Address whose messages the process trusts. Defaults to `schedulerLocation`. */
  authority?: string
  /**
   * Scheduler node address. Defaults to the target node's own operator address.
   * Must match a node identity, or the node redirects to a remote scheduler —
   * which is exactly the third-party dependency this migration exists to remove.
   */
  schedulerLocation?: string
  /**
   * Extra tags (unique, lowercase). secp256k1 signing is deterministic, so two
   * spawns with identical content from one wallet produce the SAME process id.
   * Include something unique (e.g. `name`) when you want a distinct process.
   */
  tags?: Tag[]
  /**
   * Spawn-message data. Our contracts use this to carry a MIGRATION SEED, which the
   * runtime consumes at slot 0 and never again — that is what lets the published
   * module stay pure source instead of embedding the dump. Embedding it cost a
   * json.decode of the entire dump on every read (the module is reloaded into a
   * fresh VM per read): measured 2.60s/read vs 0.43s, same resulting state.
   *
   * Ignored with `luaSource`, which already uses `data` for the inline bundle.
   */
  data?: string | Uint8Array
  /**
   * Force the process's FIRST COMPUTE and confirm it resolves before returning
   * (default true, costing one extra GET).
   *
   * HyperBEAM computes LAZILY: `/push` only schedules slot 0, it does not run it. A process
   * that has never computed still answers 200 on most reads — it just has no state — so a
   * broken or unseeded spawn looks identical to a healthy one until something much later
   * reads the wrong answer. `@permaweb/aoconnect` resolved `now` after a spawn for exactly
   * this reason; that verification is restored here rather than left to each caller.
   *
   * Under the D32 globals state model this stopped being cosmetic: `as/<view>` does NOT
   * drive slot 0, so without this a just-spawned process serves views from the contract's
   * declared EMPTY shape — including a migrate-on-spawn seed, where a seed diff would then
   * compare against nothing and look plausible.
   *
   * Set false only when you deliberately want the pre-compute window (a probe measuring it).
   *
   * ⚠️ This proves the process COMPUTES, not that a seed LANDED. For that use `materialize`,
   * which additionally waits for the native runtime's `status.initialized`.
   */
  verify?: boolean
  /** Attempts for the spawn verification above. Default 30. */
  verifyAttempts?: number
  /** Delay between verification attempts, ms. Default 500. */
  verifyDelayMs?: number
}

export interface SendOptions {
  /** Target process id. */
  processId: string
  /** Action name — sugar for a `action` tag. */
  action?: string
  tags?: Tag[]
  data?: string | Uint8Array
  /**
   * Verify the CONTRACT accepted the message, not just that the node scheduled it
   * (default true, costing one extra GET).
   *
   * A rejected write still returns HTTP 200 — the push succeeded, the compute
   * failed — so without this a caller cannot distinguish "round settled" from
   * "round silently did nothing". Set false only for writes whose outcome you
   * establish by some other means.
   */
  confirm?: boolean
}

export interface SendResult {
  /** The signed DataItem id of the message. */
  id: string
  /** Assigned slot, when the node reports one. */
  slot: string | null
  /** Raw push response body (the signed assignment). */
  body: string
  /**
   * The contract's own output for this message — `OK`, or a JSON payload for
   * handlers that return one. Present unless `confirm` was disabled or the node
   * reported no slot.
   */
  output?: string
}

export interface SpawnResult {
  /** The new process id (= the signed DataItem id). */
  processId: string
  slot: string | null
}

/** Params for a parameterized view, e.g. `{ address: '0x…' }`. */
export type ViewParams = Record<string, string | number | boolean>
