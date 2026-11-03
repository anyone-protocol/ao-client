# Changelog

Consumers pin this package by GIT TAG (`github:anyone-protocol/ao-client#vX.Y.Z`), so a
release is: bump the version here and in `package.json`, `npm run build` (dist/ is committed
on purpose — see `.gitignore`), commit, tag, push the tag.

## v0.1.4

### Changed

- **`spawnProcess` posts to `/~scheduler@1.0/schedule` instead of `/push`.** HyperBEAM v0.11
  answers `POST /push` with 404. Messages still go to `/<pid>~process@1.0/push`.
- `spawnProcess` rejects `data` passed alongside inline `luaSource`, since the inline module
  occupies the data field.

### Added

- `docs/wire-format.md`, the signed message layout the client produces.

## v0.1.3

Follows the contract-side move of state into Lua globals (D32). Nothing is deployed anywhere
yet, so the API changes freely — but note that an OLD client against a NEW contract reads
**200 with empty state**, a silent wrong answer rather than an error, so pins should move.

### Changed

- **`readView` now resolves `as/<name>` instead of `now/~lua@5.3a/<name>`.** `now` resolves
  first and hands the Lua device a priv-stripped message, so it re-initialises a FRESH VM from
  the module: the view function is present and callable, but every data global is nil. `as/`
  applies the execution device to the LOADED process, against the restored VM that holds the
  state. Query params and retries are unchanged.
### Removed

- **`readState`.** Contract state is not addressable on the process message any more, so the
  name could only lie. Nothing called it — the four controllers use `readView`/`readSlotOutput`,
  and the smart-contracts scripts have their own `hb-client` helper of the same name. Deleting
  it makes a stale call a compile error instead of a plausible 404. For message keys
  (`results/output/data`, `at-slot`, `allowlistId`) use `readRaw(config, pid, 'now/<key>')`.

### Added

- **`spawnProcess` verifies its own first compute** (`verify`, default true; `verifyAttempts`,
  `verifyDelayMs`). `/push` only SCHEDULES slot 0 — HyperBEAM computes lazily — and a process
  that has never computed still answers 200 on most reads, it just has no state. So an unseeded
  or broken spawn was indistinguishable from a healthy one until something much later read the
  wrong answer. `@permaweb/aoconnect` resolved `now` after a spawn for exactly this reason.
  Deliberately contract-agnostic: it resolves `now/at-slot`, present on every process, NOT a
  `status` view only our runtime has. Pass `verify: false` for a process that cannot compute
  by design (an admission probe).
- **`materialize(pid, opts?)`** — force the first compute AND wait for the native runtime's
  `status.initialized`. Use for a pid obtained some other way, or when you need proof a
  migration SEED landed. Spawn verification proves the process computes; it does not prove that.

### Note

`sendMessage` needed no change: it already confirms through `readSlotOutput`, and that read
forces the compute. Spawn was the only gap.

## v0.1.2

`data` added to `SpawnOptions`, for migration seeds carried on the spawn message.

## v0.1.1

Full error taxonomy exported; `nodeUrlFromEnv` raises `AoValidationError`. `dist/` committed so
a git-dependency install needs no lifecycle script.

## v0.1.0

Initial release. HyperBEAM-native AO client: ANS-104/EVM-signed writes, plain-HTTP reads.
