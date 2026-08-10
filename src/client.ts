import { createData } from '@dha-team/arbundles/web'
import {
  assertTagsWellFormed, base64url, concat, encodeMapBundle, toBytes,
} from './wire.js'
import {
  AoContractError, AoHttpError, AoNotFoundError, AoValidationError, isRetryable,
} from './errors.js'
import type {
  AoConfig, SendOptions, SendResult, SigningConfig, SpawnOptions, SpawnResult,
  Tag, ViewParams,
} from './types.js'

const ANS104_HEADERS = {
  'Content-Type': 'application/ans104',
  'codec-device': 'ans104@1.0',
}

function requireUrl (config: AoConfig): string {
  if (!config.url) {
    throw new AoValidationError(
      '`url` is required and has no default. Point it at our own node (HB_URL). ' +
      'Falling back to a public endpoint is the failure mode this package exists ' +
      'to prevent.'
    )
  }
  return config.url.replace(/\/+$/, '')
}

function requireSigner (config: AoConfig): asserts config is SigningConfig {
  if (!config.signer) {
    throw new AoValidationError('a `signer` is required for writes (spawn/send).')
  }
}

async function withRetry<T> (
  config: AoConfig,
  label: string,
  fn: () => Promise<T>
): Promise<T> {
  const attempts = Math.max(1, config.retries ?? 3)
  let last: unknown
  for (let i = 1; i <= attempts; i++) {
    try {
      return await fn()
    } catch (e) {
      last = e
      if (i === attempts || !isRetryable(e)) break
      const backoff = 250 * 2 ** (i - 1)
      config.logger?.warn?.(
        `ao-client: ${label} failed (attempt ${i}/${attempts}), retrying in ${backoff}ms`,
        e instanceof Error ? e.message : e
      )
      await new Promise(r => setTimeout(r, backoff))
    }
  }
  throw last
}

async function request (
  config: AoConfig,
  method: string,
  path: string,
  init?: RequestInit
): Promise<{ res: Response, body: string }> {
  const url = requireUrl(config)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), config.timeoutMs ?? 60_000)
  try {
    const res = await fetch(`${url}${path}`, {
      method,
      redirect: 'follow',
      signal: controller.signal,
      ...init,
    })
    const body = await res.text()
    if (!res.ok) throw new AoHttpError(res.status, method, path, body)
    return { res, body }
  } finally {
    clearTimeout(timer)
  }
}

async function postAns104 (
  config: SigningConfig,
  path: string,
  opts: { tags: Tag[], data: string | Uint8Array, target?: string }
) {
  assertTagsWellFormed(opts.tags)
  const item = createData(opts.data as never, config.signer, {
    tags: opts.tags,
    ...(opts.target ? { target: opts.target } : {}),
  })
  await item.sign(config.signer)
  const { res, body } = await request(config, 'POST', path, {
    headers: ANS104_HEADERS,
    body: item.getRaw() as unknown as BodyInit,
  })
  return { id: item.id, res, body }
}

// ---------------------------------------------------------------------------
// Node identity
// ---------------------------------------------------------------------------

/** The node's operator wallet address (43-char base64url). */
export async function fetchNodeAddress (config: AoConfig): Promise<string> {
  const { body } = await request(config, 'GET', '/~meta@1.0/info/address')
  return body.trim()
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/**
 * Spawn a native `lua@5.3a` process.
 *
 * Prefer `moduleId` (upload once, reference by id). `luaSource` embeds the module
 * inline in the spawn, which is useful for smoke tests but bloats every subsequent
 * slot by the module size — the node begins rejecting pushes once its cache crosses
 * roughly 1 MB.
 *
 * Fail-closed by design: `execution-device`, `scheduler-device`, `variant` and
 * `scheduler-location` are set explicitly here rather than left to a default. The
 * incident that started this migration was caused by defaults nobody had set.
 */
export async function spawnProcess (
  config: AoConfig,
  opts: SpawnOptions
): Promise<SpawnResult> {
  requireSigner(config)
  if (!opts.moduleId === !opts.luaSource) {
    throw new AoValidationError('exactly one of `moduleId` or `luaSource` is required')
  }
  // An inline-source spawn encodes the module INTO the data field, so it cannot also carry
  // spawn data there — it would be silently discarded and the process would come up without
  // its seed while every call reported success. Seeding requires a module-id spawn.
  if (opts.luaSource && opts.data) {
    throw new AoValidationError(
      '`data` cannot be combined with `luaSource`: the inline module occupies the data field, ' +
      'so the spawn data would be discarded. Publish the module and spawn by `moduleId`.'
    )
  }
  const schedulerLocation =
    opts.schedulerLocation ?? await fetchNodeAddress(config)
  const processTags: Tag[] = [
    { name: 'device', value: 'process@1.0' },
    { name: 'type', value: 'Process' },
    { name: 'scheduler-device', value: 'scheduler@1.0' },
    { name: 'execution-device', value: 'lua@5.3a' },
    { name: 'push-device', value: 'push@1.0' },
    { name: 'scheduler-location', value: schedulerLocation },
    { name: 'authority', value: opts.authority ?? schedulerLocation },
    { name: 'data-protocol', value: 'ao' },
    { name: 'variant', value: 'ao.N.1' },
    ...(opts.moduleId ? [{ name: 'module', value: opts.moduleId }] : []),
    ...(opts.tags ?? []),
  ]

  let tags = processTags
  let data: Uint8Array = opts.data ? toBytes(opts.data) : new Uint8Array(0)
  if (opts.luaSource) {
    const bundle = await encodeMapBundle({
      module: {
        tags: [{ name: 'content-type', value: 'application/lua' }],
        data: opts.luaSource,
      },
    })
    tags = [...bundle.bundleTags, ...processTags]
    data = bundle.data
  }

  // A spawn is NOT retried: secp256k1 signing is deterministic, so a retry of
  // identical content yields the same id, but a retry after a partially-applied
  // spawn is not something we want to paper over silently.
  const { id, res } = await postAns104(config, '/push', { tags, data })
  const processId = res.headers.get('process') ?? id
  // `/push` only SCHEDULES slot 0 — HyperBEAM computes lazily. Force it and confirm the
  // process resolves, so a spawn that cannot compute fails HERE rather than as a puzzling
  // empty read later. See SpawnOptions.verify.
  if (opts.verify !== false) {
    await forceFirstCompute(config, processId,
      { attempts: opts.verifyAttempts, delayMs: opts.verifyDelayMs })
  }
  return { processId, slot: res.headers.get('slot') }
}

/**
 * Resolve `now/at-slot` until the node answers, which is what drives a lazily-scheduled
 * slot 0 to actually run. Returns the slot.
 *
 * Any `now/` read forces the schedule; `at-slot` is the cheapest and is present on every
 * process regardless of execution device, so this stays contract-agnostic — it must not
 * depend on a `status` view that only our native runtime has.
 */
async function forceFirstCompute (
  config: AoConfig,
  processId: string,
  opts: { attempts?: number, delayMs?: number } = {}
): Promise<string> {
  const attempts = opts.attempts ?? 30
  const delayMs = opts.delayMs ?? 500
  let last: unknown = null
  for (let i = 0; i < attempts; i++) {
    try {
      return (await readRaw(config, processId, 'now/at-slot')).trim()
    } catch (e) { last = e }
    if (i < attempts - 1) await new Promise(r => setTimeout(r, delayMs))
  }
  throw new Error(
    `ao-client: spawned ${processId} but it never computed after ${attempts} attempts ` +
    `(last: ${String((last as Error)?.message ?? last).slice(0, 200)})`
  )
}

/**
 * Send an interaction to a process. Replaces `sendAosMessage`.
 *
 * Retried on transport/5xx failures only — a 4xx means the node or the contract
 * rejected the message, and repeating it just repeats the rejection.
 */
export async function sendMessage (
  config: AoConfig,
  opts: SendOptions
): Promise<SendResult> {
  requireSigner(config)
  if (!opts.processId) throw new AoValidationError('`processId` is required')
  const tags: Tag[] = [
    { name: 'type', value: 'Message' },
    { name: 'data-protocol', value: 'ao' },
    { name: 'variant', value: 'ao.N.1' },
    { name: 'require-codec', value: 'application/json' },
    ...(opts.action ? [{ name: 'action', value: opts.action }] : []),
    ...(opts.tags ?? []),
  ]
  const sent = await withRetry(config, `send ${opts.action ?? 'message'}`, async () => {
    const { id, res, body } = await postAns104(
      config,
      `/${opts.processId}~process@1.0/push`,
      { tags, data: opts.data ?? '', target: opts.processId }
    )
    let slot = res.headers.get('slot')
    if (slot === null) {
      try { slot = String(JSON.parse(body).slot) } catch { /* leave null */ }
    }
    return { id, slot, body }
  })

  if (opts.confirm === false) return sent

  // Confirm the CONTRACT accepted it, not merely that the node scheduled it.
  // Reads the message's OWN slot rather than `now/`: `now/` reflects the latest
  // slot, so under a concurrent writer it can report someone else's result.
  if (sent.slot === null) {
    config.logger?.warn?.(
      `ao-client: node returned no slot for ${opts.action ?? 'message'}; cannot ` +
      'confirm the contract accepted it. Treating as sent.'
    )
    return sent
  }
  const output = (await readSlotOutput(config, opts.processId, sent.slot)).trim()
  const reason = parseContractError(output)
  if (reason !== null) {
    throw new AoContractError(reason, opts.processId, sent.slot, opts.action)
  }
  return { ...sent, output }
}

/**
 * A rejected handler yields `error: <reason>` as the slot's output — the runtime
 * emits that shape for an unknown action, an ACL denial, a snapshot failure, and
 * for anything the pcall'd handler itself throws (runtime/native.lua). Any other
 * output — `OK`, a JSON payload — is a success.
 */
function parseContractError (output: string): string | null {
  return /^error:\s*/i.test(output) ? output.replace(/^error:\s*/i, '') : null
}

// ---------------------------------------------------------------------------
// Reads — plain unsigned HTTP GETs (D4). No signing, no scheduled message, no
// new slot. This is what replaces every `dryrun` call site.
// ---------------------------------------------------------------------------

/** Raw GET against a process path, e.g. `as/rewards?address=0x…` or `now/results/output/data`. */
export async function readRaw (
  config: AoConfig,
  processId: string,
  path: string
): Promise<string> {
  const clean = path.replace(/^\/+/, '')
  try {
    const { body } = await request(config, 'GET', `/${processId}~process@1.0/${clean}`)
    return body
  } catch (e) {
    if (e instanceof AoHttpError && e.status === 404) {
      throw new AoNotFoundError(`${processId}/${clean}`)
    }
    throw e
  }
}

/**
 * Invoke a contract view: `as/<name>[?params]`, parsed as JSON.
 * This is the replacement for a `dryrun` carrying an `Action` tag.
 *
 * ⚠️ `as/`, NOT `now/~lua@5.3a/` — this is load-bearing, not cosmetic (D31 §5a, measured).
 * `now` resolves FIRST and hands the lua device a priv-stripped result message, so the device
 * re-initialises a FRESH VM from the module: the view function is present and callable, but
 * every data global is nil, and the view answers 200 with empty state. `as/` goes through
 * `dev_process:as/3` -> `ensure_loaded`, applying the execution device to the LOADED process,
 * so the view runs against the restored VM that actually holds the state. It advances to the
 * latest slot, so it is not a stale read.
 *
 * ⚠️ ONE EXCEPTION, and it only bites right after a spawn: HyperBEAM computes LAZILY, and `as/`
 * does not drive SLOT 0. A process that has never computed holds no state at all, so its views
 * answer from the contract's declared (empty) shape — a plausible-looking 200 that is simply
 * not the seed. Touching any `now/` key forces the schedule to run; `materialize` below does
 * exactly that, once. Steady-state reads do not need it — `as/` picks up later slots by itself.
 */
export async function readView<T = unknown> (
  config: AoConfig,
  processId: string,
  name: string,
  params?: ViewParams
): Promise<T> {
  const query = params && Object.keys(params).length
    ? '?' + new URLSearchParams(
        Object.entries(params).map(([k, v]) => [k, String(v)])
      ).toString()
    : ''
  return withRetry(config, `read view ${name}`, async () => {
    const body = await readRaw(config, processId, `as/${name}${query}`)
    try {
      return JSON.parse(body) as T
    } catch {
      throw new Error(
        `ao-client: view "${name}" did not return JSON (got ${body.slice(0, 120)}). ` +
        `A view name that collides with a HyperBEAM process key is shadowed on the ` +
        `read path and returns the base value instead — check the view name.`
      )
    }
  })
}

/**
 * Force a freshly spawned process to compute, and wait until it has.
 *
 * Call once after `spawnProcess`, before reading any view. HyperBEAM's compute is lazy and
 * `as/` does not drive slot 0, so without this a just-spawned process serves views from the
 * contract's declared empty shape — including a migrate-on-spawn seed, which is the dangerous
 * case: a seed diff would compare against empty and either fail confusingly or, worse, look
 * plausible. Reading any `now/` key resolves the schedule and runs the pending slot.
 *
 * Returns the process's `status` view once it reports `initialized`. Throws if it never does.
 */
export async function materialize<T = unknown> (
  config: AoConfig,
  processId: string,
  opts: { attempts?: number, delayMs?: number } = {}
): Promise<T> {
  const attempts = opts.attempts ?? 30
  const delayMs = opts.delayMs ?? 1000
  let last: unknown = null
  for (let i = 0; i < attempts; i++) {
    // The `now/` read is the part that does the work — it forces the pending slot to compute.
    // `spawnProcess` already does this, so for a process spawned through this client the loop
    // normally exits on its first pass; this stays for pids obtained some other way.
    await forceFirstCompute(config, processId, { attempts: 1 }).catch(() => '')
    try {
      const status = await readView<{ initialized?: boolean }>(config, processId, 'status')
      last = status
      // `initialized` distinguishes "computed and genuinely empty" from "has never computed";
      // the counts cannot, because both answer zero. Contracts predating it are treated as
      // materialized the moment status answers at all.
      if (status?.initialized !== false) return status as T
    } catch (e) {
      last = e
    }
    if (i < attempts - 1) await new Promise(r => setTimeout(r, delayMs))
  }
  throw new Error(
    `ao-client: ${processId} did not materialize after ${attempts} attempts ` +
    `(last: ${JSON.stringify(last)?.slice(0, 200)})`
  )
}

/** Slot output of a specific message, for reads served from a settle slot. */
export function readSlotOutput (
  config: AoConfig,
  processId: string,
  slot: string | number
): Promise<string> {
  return withRetry(config, `read slot ${slot}`, () =>
    readRaw(config, processId, `compute&slot=${slot}/results/output/data`))
}

export {
  AoContractError, AoHttpError, AoNotFoundError, AoValidationError,
} from './errors.js'
export { base64url, concat, toBytes }
export { moduleIdFor } from './wire.js'
