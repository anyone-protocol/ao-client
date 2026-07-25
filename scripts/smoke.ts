// Live smoke test: drives every verb in the package against a real HyperBEAM node,
// using the seeded native staking-rewards module as the target. This is the check
// that matters — a typecheck proves nothing about ANS-104 byte layout, tag ordering
// or signature round-tripping.
//
// Run: HB_URL=http://localhost:8734 MODULE_ID=<staking seed id> bun run scripts/smoke.ts
import { EthereumSigner } from '@dha-team/arbundles/web'
import { createAoClient, nodeUrlFromEnv, AoNotFoundError } from '../src/index.js'

const MODULE_ID = process.env.MODULE_ID
if (!MODULE_ID) { console.error('MODULE_ID env required'); process.exit(2) }

// Throwaway dev key — deliberately not a production wallet.
const KEY = (process.env.DEPLOYER_PRIVATE_KEY
  || '80611882d38e5502d93305c88b64da234fea23037334ecb9a647249076c5fa37').replace(/^0x/, '')

const ao = createAoClient({
  url: nodeUrlFromEnv(),
  signer: new EthereumSigner(KEY),
  logger: { warn: (m, ...r) => console.log('  [retry]', m, ...r) },
})

let fails = 0
const check = (ok: boolean, label: string, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`)
  if (!ok) fails++
}

;(async () => {
  console.log(`node ${await ao.fetchNodeAddress()}  module ${MODULE_ID}\n`)

  console.log('1) fail-closed config:')
  try {
    nodeUrlFromEnv({}, 'HB_URL')
    check(false, 'missing HB_URL throws', 'it did not')
  } catch { check(true, 'missing HB_URL throws rather than defaulting') }
  try {
    nodeUrlFromEnv({ HB_URL: 'hb.anyone.tech' })
    check(false, 'non-absolute URL throws', 'it did not')
  } catch { check(true, 'non-absolute URL throws') }
  try {
    await createAoClient({ url: '' }).fetchNodeAddress()
    check(false, 'empty url throws', 'it did not')
  } catch { check(true, 'empty url throws') }
  try {
    await createAoClient({ url: ao.config.url }).sendMessage({ processId: 'x' })
    check(false, 'write without a signer throws', 'it did not')
  } catch { check(true, 'write without a signer throws') }

  console.log('\n2) malformed tags rejected before signing:')
  for (const [tags, why] of [
    [[{ name: 'Round-Timestamp', value: '1' }], 'uppercase'],
    [[{ name: 'module/body', value: 'x' }], 'path-flattened'],
    [[{ name: 'a', value: '1' }, { name: 'a', value: '2' }], 'duplicate'],
  ] as const) {
    try {
      await ao.sendMessage({ processId: 'x', tags: [...tags] })
      check(false, `${why} tag rejected`, 'it was accepted')
    } catch (e) {
      check(String(e).includes('ao-client:'), `${why} tag rejected`, String(e).slice(0, 70))
    }
  }

  console.log('\n3) spawn:')
  const { processId, slot } = await ao.spawnProcess({
    moduleId: MODULE_ID,
    tags: [{ name: 'name', value: `ao-client-smoke-${Date.now()}` }],
  })
  check(!!processId && processId.length === 43, 'spawned a process', `${processId} slot=${slot}`)

  console.log('\n4) reads (plain GET — no signing, no slot):')
  let status: any
  for (let i = 0; i < 40; i++) {
    try { status = await ao.readView(processId, 'status'); break }
    catch { await new Promise(z => setTimeout(z, 1500)) }
  }
  check(!!status, 'readView(status)', status ? `${status.counts.rewardedHodlers} hodlers seeded` : 'never answered')
  check(status?.tokensPerSecond === '57870370370370370', 'seeded config visible', status?.tokensPerSecond)

  const dump: any = await ao.readView(processId, 'dump')
  check(Object.keys(dump.Rewarded).length === 562, 'readView(dump) — the View-State replacement',
    `${Object.keys(dump.Rewarded).length} hodlers`)

  const hodler = Object.keys(dump.Rewarded)[0]!
  const operator = Object.keys(dump.Rewarded[hodler])[0]!
  const point = (await ao.readState(processId, `Rewarded/${hodler}/${operator}`)).trim()
  check(point === dump.Rewarded[hodler][operator], 'readState base-addressed point lookup', point)

  const rewards: any = await ao.readView(processId, 'rewards', { address: hodler })
  check(!!rewards?.Rewarded, 'readView with params (Get-Rewards replacement)',
    JSON.stringify(rewards.Rewarded).slice(0, 50))

  try {
    await ao.readState(processId, 'Rewarded/0xdeadbeef')
    check(false, 'missing key raises AoNotFoundError', 'no error raised')
  } catch (e) {
    check(e instanceof AoNotFoundError, 'missing key raises AoNotFoundError', (e as Error).name)
  }

  console.log('\n5) write, then observe the effect:')
  const prev = Number(await ao.readState(processId, 'PreviousRound/Timestamp'))
  const t = prev + 3600_000
  const H = hodler, O = operator
  await ao.sendMessage({
    processId,
    action: 'Add-Scores',
    tags: [{ name: 'round-timestamp', value: String(t) }],
    data: JSON.stringify({ Scores: { [H]: { [O]: { Staked: '1000000000000000000000', Running: 1 } } } }),
  })
  const pending: any = await ao.readView(processId, 'status')
  check(pending.counts.pendingRounds === 1, 'Add-Scores staged a pending round',
    String(pending.counts.pendingRounds))

  await ao.sendMessage({
    processId,
    action: 'Complete-Round',
    tags: [{ name: 'round-timestamp', value: String(t) }],
  })
  const after: any = await ao.readView(processId, 'last_round')
  check(after.Timestamp === t, 'Complete-Round settled and advanced PreviousRound', String(after.Timestamp))
  check(after.Period === 3600, 'Period', String(after.Period))

  console.log('\n6) contract rejection surfaces as an error (not a silent pass):')
  try {
    await ao.sendMessage({
      processId,
      action: 'Complete-Round',
      tags: [{ name: 'round-timestamp', value: String(t - 1) }],
    })
    check(false, 'backdated round rejected', 'it was accepted')
  } catch (e) {
    check(true, 'backdated round rejected', String(e).slice(0, 80))
  }

  console.log(`\n${fails === 0 ? 'ALL PASS' : fails + ' FAILURE(S)'}  —  pid=${processId}`)
  process.exit(fails ? 1 : 0)
})().catch(e => { console.error('FATAL', String(e?.stack || e).slice(0, 700)); process.exit(2) })
