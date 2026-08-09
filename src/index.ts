/**
 * @anyone-protocol/ao-client
 *
 * The single AO transport for Anyone Protocol, replacing @permaweb/aoconnect and
 * the seven divergent `send-aos-message.ts` copies (D15/D16/D17).
 *
 * Writes are ANS-104 DataItems signed with an EVM wallet and POSTed to our own
 * HyperBEAM node. Reads are plain unsigned HTTP GETs against the process's own
 * device (D4) — no signing, no scheduled message, no new slot.
 *
 *   import { createAoClient } from '@anyone-protocol/ao-client'
 *   import { EthereumSigner } from '@dha-team/arbundles'
 *
 *   const ao = createAoClient({ url: process.env.HB_URL!, signer: new EthereumSigner(key) })
 *   const state = await ao.readView(processId, 'dump')
 *   await ao.sendMessage({ processId, action: 'Complete-Round',
 *                          tags: [{ name: 'round-timestamp', value: String(ts) }] })
 */
import {
  fetchNodeAddress, materialize, readRaw, readSlotOutput, readView, sendMessage,
  spawnProcess,
} from './client.js'
import { AoValidationError } from './errors.js'
import type {
  AoConfig, SendOptions, SendResult, SpawnOptions, SpawnResult, ViewParams,
} from './types.js'

export * from './types.js'
// The full error taxonomy is part of the public surface: consumers branch on these
// (a contract rejection is a business outcome, a 5xx is an outage). Exporting from
// './errors.js' directly rather than re-listing through client.js, so adding an
// error class cannot silently fail to reach consumers.
export * from './errors.js'
export {
  fetchNodeAddress, materialize, moduleIdFor, readRaw, readSlotOutput, readView,
  sendMessage, spawnProcess,
} from './client.js'

export interface AoClient {
  readonly config: AoConfig
  fetchNodeAddress(): Promise<string>
  spawnProcess(opts: SpawnOptions): Promise<SpawnResult>
  sendMessage(opts: SendOptions): Promise<SendResult>
  readView<T = unknown>(processId: string, name: string, params?: ViewParams): Promise<T>
  readSlotOutput(processId: string, slot: string | number): Promise<string>
  /** Force a just-spawned process to compute (lazy eval); resolves once initialized. */
  materialize<T = unknown>(processId: string, opts?: { attempts?: number, delayMs?: number }): Promise<T>
  readRaw(processId: string, path: string): Promise<string>
}

/** Bind a config once; every method below is the free function with it applied. */
export function createAoClient (config: AoConfig): AoClient {
  return {
    config,
    fetchNodeAddress: () => fetchNodeAddress(config),
    spawnProcess: opts => spawnProcess(config, opts),
    sendMessage: opts => sendMessage(config, opts),
    readView: (processId, name, params) => readView(config, processId, name, params),
    readSlotOutput: (processId, slot) => readSlotOutput(config, processId, slot),
    materialize: (processId, opts) => materialize(config, processId, opts),
    readRaw: (processId, path) => readRaw(config, processId, path),
  }
}

/**
 * Read the node URL from the environment, failing closed.
 *
 * There is no default and there must never be one. Every service in this
 * migration points at our own node explicitly; the legacynet outage happened
 * because nothing set MU_URL, two services silently used a public CU, and
 * deploy.ts carried hardcoded third-party fallbacks.
 */
export function nodeUrlFromEnv (
  env: Record<string, string | undefined> = process.env,
  varName = 'HB_URL'
): string {
  const url = env[varName]?.trim()
  if (!url) {
    throw new AoValidationError(
      `${varName} is not set. It must point at our HyperBEAM node ` +
      '(e.g. https://hb.anyone.tech). There is deliberately no default.'
    )
  }
  if (!/^https?:\/\//.test(url)) {
    throw new AoValidationError(`${varName} must be an absolute http(s) URL, got "${url}"`)
  }
  return url
}
