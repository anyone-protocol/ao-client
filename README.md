# @anyone-protocol/ao-client

The single AO transport for Anyone Protocol. Replaces `@permaweb/aoconnect` and the
seven divergent copies of `send-aos-message.ts` (D15/D16/D17).

- **Writes** are ANS-104 DataItems, EVM-signed, POSTed to our own HyperBEAM node.
- **Reads** are plain unsigned HTTP GETs against the process's own device (D4) — no
  signing, no scheduled message, no new slot, no `dryrun`.

Works in Node (six NestJS/CommonJS services) and in the browser (the Nuxt dashboard);
the package ships both ESM and CJS builds.

## Install

Consumed as a **git dependency** — deliberately, and temporarily. There is no npm
registry to publish to yet: GitHub Packages' npm registry requires authentication
even for public packages, which would mean threading a token into six services' CI
*and* their Docker builds for a package that is public and AGPL anyway. A git
dependency needs no registry, no auth, and no infrastructure, and moving to a real
registry later is a one-line change in each consumer's `package.json`.

```jsonc
// package.json
"dependencies": {
  "@anyone-protocol/ao-client": "github:anyone-protocol/ao-client#v0.1.0",
  "@dha-team/arbundles": "^1.0.3"
}
```

Pin a **tag or commit sha**, never a branch — the API is still moving, and a floating
branch would let a consumer's build change underneath it.

`dist/` **is committed**, so no build runs on install. That is deliberate: `prepare`
alone is not reliable across our consumers — **bun blocks lifecycle scripts by default**
(the install succeeds and silently yields no `dist/`), and Docker builds commonly use
`--ignore-scripts`. A committed build works identically under npm, bun, yarn and pnpm
with no per-consumer configuration.

The cost is that `dist/` can go stale against `src/`. **Run `npm run build` and commit
before tagging** — the tag is what consumers pin.

`@dha-team/arbundles` is a peer dependency — you supply the signer.

The trade-offs of this being a git dep: no semver ranges, no dist-tags, no `npm audit`
surface. Fine while the API is unstable; revisit once it settles.

## Usage

```ts
import { createAoClient, nodeUrlFromEnv } from '@anyone-protocol/ao-client'
import { EthereumSigner } from '@dha-team/arbundles/web'

const ao = createAoClient({
  url: nodeUrlFromEnv(),            // HB_URL — required, no default
  signer: new EthereumSigner(privateKey),
  logger,                           // optional
})

// read — every read is a view. Contract state lives in a Lua global (D32), so there is
// no addressable `now/state/<key>` any more; a point lookup is a view with a parameter.
const state = await ao.readView(processId, 'dump')
const mine  = await ao.readView(processId, 'rewards', { address })

// write — throws if the contract rejects it
await ao.sendMessage({
  processId,
  action: 'Complete-Round',
  tags: [{ name: 'round-timestamp', value: String(ts) }],
})
```

In the browser, pass an `InjectedEthereumSigner` built from `window.ethereum`; that
path is the one validated in the D6 conformance suite (Rabby and Phantom).

## Migrating from `send-aos-message.ts`

**Writes** map one-to-one:

```ts
// before
await sendAosMessage({ processId, signer, tags: [{ name: 'Action', value: 'Add-Scores' }, …] })
// after
await ao.sendMessage({ processId, action: 'Add-Scores', tags: [ … ] })
```

Note tag names must be **lowercase** (`round-timestamp`, not `Round-Timestamp`) — the
package throws rather than let you produce a message that fails signature
re-verification on a later read.

**Reads** do not map one-to-one, because `dryrun` no longer exists. Each legacy
`Action` becomes a **view** — including point lookups, which take a parameter rather than a
path (contract state is a Lua global, not a message key):

| Legacy `dryrun` Action | Native read |
| --- | --- |
| `View-State` | `readView(pid, 'dump')` — admin/seed-diff only; a full-state pull is rarely what you want |
| `Last-Snapshot` | `readView(pid, 'last_snapshot')` |
| `Last-Round-Metadata` | `readView(pid, 'last_round')` |
| `Last-Round-Data` | staking: `readView(pid, 'last_round_data', { address })` · relay: read the settle slot (D27 W-D) |
| `Get-Rewards` | `readView(pid, 'rewards', { address })` |
| `Get-Claimed` | `readView(pid, 'claimed', { address })` |
| `Balance` | **delete** — the AO token integration is out of scope (D17) |

Point lookups go through a view too: `readView(pid, 'rewards', { fingerprint })`. This is not
a workaround — a view read measured **27.6 ms against 148 ms** for the base-addressed read it
replaces, because the state is already live in the VM when the view runs. Doing the work inside
Lua and returning little is the cheap direction.

## Design notes

**No default node URL, ever.** `url` is required and `nodeUrlFromEnv()` throws when
`HB_URL` is unset. The legacynet outage that forced this migration happened because
nothing set `MU_URL`, two services silently used a public CU, and `deploy.ts` carried
hardcoded third-party fallbacks. Do not add a default.

**A rejected write throws.** This is the subtle one: when a contract rejects a message
the push still returns **HTTP 200**, because the push succeeded and only the compute
failed. The reason appears solely in that slot's output (`error: <reason>`). By default
`sendMessage` reads the message's own slot and throws `AoContractError`, so a
round that silently did nothing cannot be mistaken for a round that settled. Pass
`confirm: false` to skip the extra GET.

The confirmation reads the message's **own slot**, not `now/` — `now/` reflects the
latest slot, so under a concurrent writer it would report someone else's result.

**Only transport failures are retried.** A 4xx, a missing key, a malformed tag and a
contract rejection are all deterministic; repeating them wastes time and prints the
same error three times. See `errors.ts`.

**Tag hygiene is enforced before signing.** Names must be unique, lowercase, and
non-path-flattened. Each rule corresponds to a real HyperBEAM failure — mixed case
forces the `original-tags` path, and flattened names make later reads throw
`missing_committed_key` at re-verification.

**`arbundles/web`, not the node build.** The node entry imports `axios` without
declaring it, so a clean install crashes at import. The web build has no fs/stream
dependencies, works under Node, and is the same code the dashboard runs — the exact
path D6 proved produces a byte-identical, node-verifiable signature.

## Development

```sh
npm run typecheck
npm run build
HB_URL=http://localhost:8734 MODULE_ID=<seed module id> bun run scripts/smoke.ts
```

The smoke test is the one that matters: a typecheck proves nothing about ANS-104 byte
layout, tag ordering, or signature round-tripping. It drives every verb against a real
node and asserts a contract rejection surfaces as an error.
