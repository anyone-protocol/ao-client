// ANS-104 wire encoding for HyperBEAM, verified against v0.9-FINAL source and a
// live node. Every rule below cost real debugging time — read the comments before
// changing anything here.
//
// - The body is a raw signed ANS-104 DataItem; headers select the codec
//   (`Content-Type: application/ans104` + `codec-device: ans104@1.0`).
// - EVM signing rides the ans104 path (sig type 3). The node recovers the
//   committer as the EIP-55 checksummed 0x address — the form our contracts see
//   as `ctx.from` and the node's faff allow-list matches against (D6).
// - Tag names MUST be unique and all-lowercase. dev_codec_ans104 skips its
//   `original-tags` preservation for "normal" tags, which is what guarantees the
//   stored message re-encodes bit-exact for signature verification. Mixed-case or
//   path-flattened (`a/b`) tag names can fail re-verification on a later read.
// - `variant` must be `ao.N.1`. `ao.TN.1` flips dev_process's default
//   execution-device to genesis-wasm@1.0 (dev_process.erl:134-139).
// - A process id IS the DataItem id = base64url(sha256(signature)).
//
// Deliberately Buffer-free and node:crypto-free: this package is consumed by the
// Nuxt/Vite dashboard as well as six CommonJS services. Hashing goes through Web
// Crypto (`globalThis.crypto.subtle`), present in both Node >=20 and browsers.
import { deepHash, serializeTags } from '@dha-team/arbundles/web'
import { AoValidationError } from './errors.js'
import type { Tag } from './types.js'

const enc = new TextEncoder()

export const toBytes = (v: string | Uint8Array): Uint8Array =>
  typeof v === 'string' ? enc.encode(v) : v

export function concat (...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0)
  const out = new Uint8Array(total)
  let at = 0
  for (const p of parts) { out.set(p, at); at += p.length }
  return out
}

export function base64url (bytes: Uint8Array): string {
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  const b64 = typeof btoa === 'function'
    ? btoa(bin)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    : (globalThis as any).Buffer.from(bytes).toString('base64')
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

async function sha256 (data: Uint8Array): Promise<Uint8Array> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', data as BufferSource)
  return new Uint8Array(digest)
}

const leBytes = (n: number, width: number): Uint8Array => {
  const b = new Uint8Array(width)
  new DataView(b.buffer).setUint32(0, n >>> 0, true)
  return b
}

const ZERO_512 = new Uint8Array(512)

/**
 * Serialize and id an UNSIGNED ans104 DataItem (rsa sig type, zeroed signature
 * and owner — ar.hrl ?DEFAULT_SIG / ?DEFAULT_OWNER). The unsigned id is the
 * sha256 of the ANS-104 deep-hash segment (dev_arweave_common.erl generate_id/2).
 */
export async function unsignedItem (
  tags: Tag[],
  data: string | Uint8Array
): Promise<{ raw: Uint8Array, id: Uint8Array }> {
  const dataBytes = toBytes(data)
  const tagsBytes = new Uint8Array(serializeTags(tags))
  const raw = concat(
    new Uint8Array([1, 0]),   // signature type 1 (rsa), little-endian
    ZERO_512,                 // signature (zeroed)
    ZERO_512,                 // owner (zeroed)
    new Uint8Array([0]),      // no target
    new Uint8Array([0]),      // no anchor
    leBytes(tags.length, 8),
    leBytes(tagsBytes.length, 8),
    tagsBytes,
    dataBytes,
  )
  const segment = await deepHash([
    enc.encode('dataitem'),
    enc.encode('1'),
    enc.encode('1'),          // signature type, as a string
    ZERO_512,                 // owner forced to default for the unsigned id
    new Uint8Array(0),        // target
    new Uint8Array(0),        // anchor
    tagsBytes,
    dataBytes,
  ])
  return { raw, id: await sha256(new Uint8Array(segment)) }
}

/**
 * Encode nested-map keys as a HyperBEAM map-bundle (ar_bundles.erl v0.9-FINAL):
 * each nested key becomes an UNSIGNED child DataItem inside a binary bundle in
 * the outer item's data, plus an unsigned manifest item (JSON of key -> child
 * unsigned id, tagged data-protocol=bundle-map, variant=0.0.1).
 *
 * The three returned bundle tags MUST be placed FIRST in the outer item: on
 * re-verification the node re-encodes tags as bundle-tags ++ committed-tag-keys
 * (dev_codec_ans104_to.erl:240-242), so any other ordering breaks the byte-exact
 * signature round-trip.
 */
export async function encodeMapBundle (
  children: Record<string, { tags: Tag[], data: string | Uint8Array }>
): Promise<{ data: Uint8Array, bundleTags: Tag[] }> {
  const entries = await Promise.all(
    Object.entries(children).map(async ([key, child]) =>
      [key, await unsignedItem(child.tags, child.data)] as const)
  )
  const manifestJson = JSON.stringify(
    Object.fromEntries(entries.map(([key, item]) => [key, base64url(item.id)]))
  )
  const manifest = await unsignedItem(
    [
      { name: 'data-protocol', value: 'bundle-map' },
      { name: 'variant', value: '0.0.1' },
    ],
    manifestJson
  )
  const items = [manifest, ...entries.map(([, item]) => item)]
  const data = concat(
    leBytes(items.length, 32),
    ...items.map(item => concat(leBytes(item.raw.length, 32), item.id)),
    ...items.map(item => item.raw),
  )
  return {
    data,
    bundleTags: [
      { name: 'bundle-format', value: 'binary' },
      { name: 'bundle-version', value: '2.0.0' },
      { name: 'bundle-map', value: base64url(manifest.id) },
    ],
  }
}

/**
 * Content-addressed id of a lua module child exactly as an inline spawn embeds it.
 * After any inline spawn the node holds this child in its local cache, so later
 * spawns can reference it by id instead of re-embedding the source — which matters:
 * the inline form bloats EVERY scheduled slot by the module size, and the node
 * starts rejecting pushes once the cache crosses ~1 MB.
 */
export async function moduleIdFor (luaSource: string): Promise<string> {
  const item = await unsignedItem(
    [{ name: 'content-type', value: 'application/lua' }],
    luaSource
  )
  return base64url(item.id)
}

/** Reject tag shapes that break the ans104 signature round-trip, loudly and early. */
export function assertTagsWellFormed (tags: Tag[]): void {
  const seen = new Set<string>()
  for (const { name } of tags) {
    if (name !== name.toLowerCase()) {
      throw new AoValidationError(
        `tag name must be lowercase for the ans104 round-trip: "${name}"`
      )
    }
    if (name.includes('/')) {
      throw new AoValidationError(
        `tag name must not be path-flattened (re-verification throws ` +
        `missing_committed_key on later reads): "${name}"`
      )
    }
    if (seen.has(name)) throw new AoValidationError(`duplicate tag name: "${name}"`)
    seen.add(name)
  }
}
