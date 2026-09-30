# Wire format

How `src/wire.ts` encodes messages for HyperBEAM, and how the package is built.

## Requests

A write is a raw signed ANS-104 DataItem in the request body. Two headers select the codec:

```
Content-Type: application/ans104
codec-device: ans104@1.0
```

## Signing and identity

- EVM signatures use ANS-104 signature type 3.
- The node recovers the signer as an EIP-55 checksummed `0x` address. Contracts see that form
  as the sender, and the node's allow-list matches against it.
- A process id is the id of its spawn DataItem: `base64url(sha256(signature))`.

## Tag rules

| Rule | Reason |
| --- | --- |
| Names are unique and lowercase | The node stores such tags without its `original-tags` fallback, so the message re-encodes bit-exact for signature verification |
| Names contain no `/` | A path-flattened name fails re-verification on a later read with `missing_committed_key` |
| `variant` is `ao.N.1` | `ao.TN.1` changes the default execution device to `genesis-wasm@1.0` |

`assertTagsWellFormed` enforces the first two before signing.

## Unsigned items

`unsignedItem` serializes a DataItem with a zeroed signature and owner. Serialized layout:

| Bytes | Content |
| --- | --- |
| 2 | Signature type 1 (RSA), little-endian |
| 512 | Signature, zeroed |
| 512 | Owner, zeroed |
| 1 | Target flag, 0 for none |
| 1 | Anchor flag, 0 for none |
| 8 | Tag count, little-endian |
| 8 | Tag byte length, little-endian |
| n | Serialized tags |
| n | Data |

The id of an unsigned item is the sha256 of the ANS-104 deep hash over these parts, in order:

| Part | Value |
| --- | --- |
| Format | `dataitem` |
| Version | `1` |
| Signature type | `1`, as a string |
| Owner | 512 zero bytes |
| Target | empty |
| Anchor | empty |
| Tags | Serialized tags |
| Data | Data |

## Map bundles

`encodeMapBundle` encodes nested keys the way HyperBEAM expects:

- Each nested key becomes an unsigned child DataItem inside a binary bundle, carried in the
  outer item's data.
- An unsigned manifest item maps each key to its child's unsigned id. It is tagged
  `data-protocol=bundle-map` and `variant=0.0.1`.
- The function returns three bundle tags: `bundle-format`, `bundle-version` and `bundle-map`.

The three bundle tags must come first in the outer item. On re-verification the node re-encodes
tags as bundle tags followed by the committed tag keys, so any other order breaks the signature
round trip.

An inline spawn uses this to embed the Lua module as the `module` child, tagged
`content-type=application/lua`.

## Module ids

`moduleIdFor(luaSource)` returns the content-addressed id of a Lua module child, exactly as an
inline spawn embeds it. After an inline spawn the node holds that child in its cache, so later
spawns can pass the id as `moduleId`.

## Build

- The package builds to both ESM and CJS, because its consumers include CommonJS services and
  an ESM browser app.
- `src/wire.ts` uses no `Buffer` and no `node:crypto`. Hashing goes through Web Crypto, which
  exists in Node 20 and later and in browsers.
- `@dha-team/arbundles` is external to the bundle. Bundling it would give a consumer two copies,
  and `instanceof Signer` checks would fail.
- Imports use `@dha-team/arbundles/web`. The Node entry imports `axios` without declaring it.
  The web build has no `fs` or `stream` dependencies and runs under Node.
