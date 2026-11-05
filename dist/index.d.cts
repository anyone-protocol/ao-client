import { Signer } from '@dha-team/arbundles/web';

/** An ANS-104 tag. Names must be unique and all-lowercase — see `wire.ts`. */
interface Tag {
    name: string;
    value: string;
}
/**
 * Where to talk and who signs.
 *
 * `url` has NO default, deliberately. The AO legacynet outage that forced this
 * migration was caused by silent third-party defaults: nothing ever set MU_URL,
 * two services read a public CU, and deploy.ts carried hardcoded fallbacks. Every
 * endpoint in this package is explicit or it throws. Do not add a default.
 */
interface AoConfig {
    /** Node base URL, e.g. https://hb.anyone.tech. Required; never defaulted. */
    url: string;
    /** arbundles Signer. Node: `EthereumSigner`. Browser: `InjectedEthereumSigner`. */
    signer?: Signer;
    /** Per-request timeout in ms (default 60_000). */
    timeoutMs?: number;
    /** Attempts for transient failures (default 3). Writes retry only when safe. */
    retries?: number;
    /** Optional sink for diagnostics; defaults to silence. */
    logger?: Logger;
}
interface Logger {
    debug?(message: string, ...meta: unknown[]): void;
    warn?(message: string, ...meta: unknown[]): void;
    error?(message: string, ...meta: unknown[]): void;
}
/** A config whose signer is known to be present — the write paths require it. */
type SigningConfig = AoConfig & {
    signer: Signer;
};
interface SpawnOptions {
    /** Id of a lua module already readable by the node (published + cached). */
    moduleId?: string;
    /** Inline lua source. Mutually exclusive with `moduleId`; see `spawnProcess`. */
    luaSource?: string;
    /** Address whose messages the process trusts. Defaults to `schedulerLocation`. */
    authority?: string;
    /**
     * Scheduler node address. Defaults to the target node's own operator address.
     * Must match a node identity, or the node redirects to a remote scheduler —
     * which is exactly the third-party dependency this migration exists to remove.
     */
    schedulerLocation?: string;
    /**
     * Extra tags (unique, lowercase). secp256k1 signing is deterministic, so two
     * spawns with identical content from one wallet produce the SAME process id.
     * Include something unique (e.g. `name`) when you want a distinct process.
     */
    tags?: Tag[];
    /**
     * Spawn-message data. Our contracts use this to carry a MIGRATION SEED, which the
     * runtime consumes at slot 0 and never again — that is what lets the published
     * module stay pure source instead of embedding the dump. Embedding it cost a
     * json.decode of the entire dump on every read (the module is reloaded into a
     * fresh VM per read): measured 2.60s/read vs 0.43s, same resulting state.
     *
     * Ignored with `luaSource`, which already uses `data` for the inline bundle.
     */
    data?: string | Uint8Array;
    /**
     * Force the process's FIRST COMPUTE and confirm it resolves before returning
     * (default true, costing one extra GET).
     *
     * HyperBEAM computes LAZILY: a spawn only schedules slot 0, it does not run it. A process
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
    verify?: boolean;
    /** Attempts for the spawn verification above. Default 30. */
    verifyAttempts?: number;
    /** Delay between verification attempts, ms. Default 500. */
    verifyDelayMs?: number;
}
interface SendOptions {
    /** Target process id. */
    processId: string;
    /** Action name — sugar for a `action` tag. */
    action?: string;
    tags?: Tag[];
    data?: string | Uint8Array;
    /**
     * Verify the CONTRACT accepted the message, not just that the node scheduled it
     * (default true, costing one extra GET).
     *
     * A rejected write still returns HTTP 200 — the push succeeded, the compute
     * failed — so without this a caller cannot distinguish "round settled" from
     * "round silently did nothing". Set false only for writes whose outcome you
     * establish by some other means.
     */
    confirm?: boolean;
}
interface SendResult {
    /** The signed DataItem id of the message. */
    id: string;
    /**
     * Assigned slot, when the node reports one. When a retry reached the process after
     * its first attempt had already landed, this is the first attempt's slot. With
     * `confirm: false` it is the slot the last attempt was given.
     */
    slot: string | null;
    /** Raw push response body (the signed assignment) of the last attempt. */
    body: string;
    /**
     * The contract's own output for this message — `OK`, or a JSON payload for
     * handlers that return one. Present unless `confirm` was disabled or the node
     * reported no slot.
     */
    output?: string;
}
interface SpawnResult {
    /** The new process id (= the signed DataItem id). */
    processId: string;
    slot: string | null;
}
/** Params for a parameterized view, e.g. `{ address: '0x…' }`. */
type ViewParams = Record<string, string | number | boolean>;

/** Any non-2xx node response. Carries the status so retries can be selective. */
declare class AoHttpError extends Error {
    readonly status: number;
    readonly method: string;
    readonly path: string;
    readonly body: string;
    constructor(status: number, method: string, path: string, body: string);
}
/** A read whose target key does not exist. Distinct from a transport failure. */
declare class AoNotFoundError extends Error {
    readonly path: string;
    constructor(path: string);
}
/** Caller-side misuse (bad tags, missing config). Never retried — it cannot improve. */
declare class AoValidationError extends Error {
    constructor(message: string);
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
declare class AoContractError extends Error {
    readonly reason: string;
    readonly processId: string;
    readonly slot: string;
    readonly action?: string | undefined;
    constructor(reason: string, processId: string, slot: string, action?: string | undefined);
}
/**
 * Only transport-level failures are worth repeating. A 4xx, a missing key, a
 * malformed tag and a contract rejection are all deterministic.
 */
declare const isRetryable: (e: unknown) => boolean;

/**
 * Content-addressed id of a lua module child exactly as an inline spawn embeds it.
 * After any inline spawn the node holds this child in its local cache, so later
 * spawns can reference it by id instead of re-embedding the source — which matters:
 * the inline form bloats EVERY scheduled slot by the module size, and the node
 * starts rejecting pushes once the cache crosses ~1 MB.
 */
declare function moduleIdFor(luaSource: string): Promise<string>;

/** The node's operator wallet address (43-char base64url). */
declare function fetchNodeAddress(config: AoConfig): Promise<string>;
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
declare function spawnProcess(config: AoConfig, opts: SpawnOptions): Promise<SpawnResult>;
/**
 * Send an interaction to a process. Replaces `sendAosMessage`.
 *
 * Retried on transport/5xx failures only — a 4xx means the node or the contract
 * rejected the message, and repeating it just repeats the rejection.
 *
 * Each call signs with a fresh random anchor, and its retries resend the same bytes.
 * The runtime skips a message id it has already processed, so distinct calls never
 * collide, and a retry whose first attempt already landed reports that attempt's slot
 * and output.
 */
declare function sendMessage(config: AoConfig, opts: SendOptions): Promise<SendResult>;
/** Raw GET against a process path, e.g. `as/rewards?address=0x…` or `now/results/output/data`. */
declare function readRaw(config: AoConfig, processId: string, path: string): Promise<string>;
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
declare function readView<T = unknown>(config: AoConfig, processId: string, name: string, params?: ViewParams): Promise<T>;
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
declare function materialize<T = unknown>(config: AoConfig, processId: string, opts?: {
    attempts?: number;
    delayMs?: number;
}): Promise<T>;
/** Slot output of a specific message, for reads served from a settle slot. */
declare function readSlotOutput(config: AoConfig, processId: string, slot: string | number): Promise<string>;

interface AoClient {
    readonly config: AoConfig;
    fetchNodeAddress(): Promise<string>;
    spawnProcess(opts: SpawnOptions): Promise<SpawnResult>;
    sendMessage(opts: SendOptions): Promise<SendResult>;
    readView<T = unknown>(processId: string, name: string, params?: ViewParams): Promise<T>;
    readSlotOutput(processId: string, slot: string | number): Promise<string>;
    /** Force a just-spawned process to compute (lazy eval); resolves once initialized. */
    materialize<T = unknown>(processId: string, opts?: {
        attempts?: number;
        delayMs?: number;
    }): Promise<T>;
    readRaw(processId: string, path: string): Promise<string>;
}
/** Bind a config once; every method below is the free function with it applied. */
declare function createAoClient(config: AoConfig): AoClient;
/**
 * Read the node URL from the environment, failing closed.
 *
 * There is no default and there must never be one. Every service in this
 * migration points at our own node explicitly; the legacynet outage happened
 * because nothing set MU_URL, two services silently used a public CU, and
 * deploy.ts carried hardcoded third-party fallbacks.
 */
declare function nodeUrlFromEnv(env?: Record<string, string | undefined>, varName?: string): string;

export { type AoClient, type AoConfig, AoContractError, AoHttpError, AoNotFoundError, AoValidationError, type Logger, type SendOptions, type SendResult, type SigningConfig, type SpawnOptions, type SpawnResult, type Tag, type ViewParams, createAoClient, fetchNodeAddress, isRetryable, materialize, moduleIdFor, nodeUrlFromEnv, readRaw, readSlotOutput, readView, sendMessage, spawnProcess };
