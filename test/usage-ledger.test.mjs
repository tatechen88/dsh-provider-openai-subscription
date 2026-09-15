/**
 * Durable usage ledger contracts.
 *
 * @module dsh-provider-openai-subscription/test/usage-ledger
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { UsageLedger, UsageLedgerCorruptError, calendarKey } from '../src/usage/ledger.js'

/** A temporary ledger path plus its directory. */
async function ledgerPath() {
  const dir = await mkdtemp(join(tmpdir(), 'usage-ledger-'))
  return join(dir, 'usage.json')
}

/** One billed fact. */
function fact(overrides = {}) {
  return {
    callId: 'call-1',
    provider: 'deepseek-official',
    model: 'deepseek-flash',
    sessionId: 's1',
    startedAt: Date.UTC(2026, 8, 15, 20, 0),
    completedAt: Date.UTC(2026, 8, 15, 20, 0, 3),
    usage: { inputTokens: 1_000_000, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 },
    ...overrides,
  }
}

const priced = { status: 'priced', currency: 'CNY', amountMicros: 1_000_000, scheduleId: 's' }

test('ledger persists facts, deduplicates by call id and reloads them', async () => {
  const path = await ledgerPath()
  const ledger = new UsageLedger({ path, debounceMs: 1 })
  assert.deepEqual(await ledger.open(), { facts: 0 })
  assert.equal(ledger.record(fact(), priced), true)
  assert.equal(ledger.record(fact(), priced), false, 'a repeated call id is not billed twice')
  assert.equal(ledger.record(fact({ callId: 'call-2', usage: { inputTokens: 0, outputTokens: 100 } }), priced), true)
  await ledger.close()

  const reopened = new UsageLedger({ path })
  assert.deepEqual(await reopened.open(), { facts: 2 })
  const summary = reopened.summary('all')
  assert.equal(summary.calls, 2)
  assert.equal(summary.usage.inputTokens, 1_000_000)
  assert.equal(summary.usage.outputTokens, 100)
  assert.deepEqual(summary.amountMicrosByCurrency, { CNY: 2_000_000 })
  await reopened.close()
})

test('ledger aggregates per session, day and month in the configured zone', async () => {
  const path = await ledgerPath()
  const ledger = new UsageLedger({ path, timeZone: 'Asia/Shanghai', now: () => Date.UTC(2026, 8, 15, 20, 0) })
  await ledger.open()
  ledger.record(fact({ callId: 'today', usage: { inputTokens: 10, outputTokens: 1 } }), priced)
  // 2026-09-15 20:00 UTC is 2026-09-16 04:00 in Beijing, i.e. a different day.
  ledger.record(fact({ callId: 'other', sessionId: 's2', startedAt: Date.UTC(2026, 8, 14, 20, 0), usage: { inputTokens: 5, outputTokens: 1 } }), priced)
  ledger.record(fact({ callId: 'lastmonth', startedAt: Date.UTC(2026, 7, 3, 0, 0), usage: { inputTokens: 7, outputTokens: 1 } }), priced)

  assert.equal(ledger.summary('today').usage.inputTokens, 10)
  assert.equal(ledger.summary('month').usage.inputTokens, 15)
  assert.equal(ledger.summary('all').usage.inputTokens, 22)
  assert.equal(ledger.sessionSummary('s1').calls, 2)
  assert.equal(ledger.sessionSummary('s2').calls, 1)
  assert.equal(ledger.sessionSummary('absent').calls, 0)

  assert.deepEqual(calendarKey(Date.UTC(2026, 8, 15, 20, 0), 'Asia/Shanghai'), { day: '2026-09-16', month: '2026-09' })
  assert.deepEqual(calendarKey(Date.UTC(2026, 8, 15, 20, 0), 'UTC'), { day: '2026-09-15', month: '2026-09' })
  await ledger.close()
})

test('an unreadable ledger is preserved rather than read as empty', async () => {
  const path = await ledgerPath()
  const ledger = new UsageLedger({ path, now: () => 42 })
  await ledger.open()
  ledger.record(fact(), priced)
  await ledger.close()

  await writeFile(path, '{ this is not json', 'utf8')
  const reader = new UsageLedger({ path, now: () => 99 })
  await assert.rejects(() => reader.open(), (error) => {
    assert.ok(error instanceof UsageLedgerCorruptError)
    assert.equal(error.backupPath, `${path}.corrupt-99`)
    return true
  })
  const files = await readdir(join(path, '..'))
  assert.ok(files.some((name) => name.startsWith('usage.json.corrupt-99')), 'the damaged file is kept beside the ledger')
})

test('a ledger from a future schema is preserved instead of silently dropped', async () => {
  const path = await ledgerPath()
  await writeFile(path, JSON.stringify({ schemaVersion: 99, entries: [] }), 'utf8')
  const ledger = new UsageLedger({ path, now: () => 7 })
  await assert.rejects(() => ledger.open(), (error) => error instanceof UsageLedgerCorruptError)
})

test('flush writes pending facts and close stops further writes', async () => {
  const path = await ledgerPath()
  const ledger = new UsageLedger({ path, debounceMs: 60_000 })
  await ledger.open()
  ledger.record(fact(), priced)
  await ledger.flush()
  const stored = JSON.parse(await readFile(path, 'utf8'))
  assert.equal(stored.schemaVersion, 2)
  assert.equal(stored.entries.length, 1)

  await ledger.close()
  assert.equal(ledger.record(fact({ callId: 'late' }), priced), false, 'a closed ledger accepts nothing new')
})

test('overlapping writes serialize and leave no temporary file behind', async () => {
  const path = await ledgerPath()
  const ledger = new UsageLedger({ path, debounceMs: 1 })
  await ledger.open()
  ledger.record(fact({ callId: 'a' }), priced)
  ledger.record(fact({ callId: 'b' }), priced)

  // A debounce timer and a flush can both fire while a write is in flight; the
  // write chain is what keeps the newest snapshot last and the temp names
  // distinct.
  const inFlight = Promise.all([ledger.write(), ledger.write(), ledger.write()])
  ledger.record(fact({ callId: 'c' }), priced)
  await inFlight
  await ledger.flush()

  const files = await readdir(join(path, '..'))
  assert.deepEqual(files.filter((name) => name.includes('.tmp-')), [], 'every temp file is renamed, not left behind')
  const stored = JSON.parse(await readFile(path, 'utf8'))
  assert.deepEqual(stored.entries.map((entry) => entry.fact.callId), ['a', 'b', 'c'], 'the durable file carries every recorded fact')
  await ledger.close()
})

test('unpriced facts count tokens without inventing money', async () => {
  const path = await ledgerPath()
  const ledger = new UsageLedger({ path })
  await ledger.open()
  ledger.record(fact({ model: 'unknown-model' }), { status: 'unpriced', reason: 'unknown-model' })
  const summary = ledger.summary('all')
  assert.equal(summary.calls, 1)
  assert.equal(summary.usage.promptTokens, 1_000_000)
  assert.deepEqual(summary.amountMicrosByCurrency, {})
  await ledger.close()
})

test('the ledger names the models it had no rate for, and only those', async () => {
  const path = await ledgerPath()
  const ledger = new UsageLedger({ path, now: () => 1 })
  await ledger.open()
  // Two calls of a model the table does not know, one call of a model it does,
  // and one call on a vendor that publishes no table at all.
  ledger.record(fact({ callId: 'v5-a', model: 'deepseek-v5', startedAt: 100 }), { status: 'unpriced', reason: 'unknown-model' })
  ledger.record(fact({ callId: 'v5-b', model: 'deepseek-v5', startedAt: 500 }), { status: 'unpriced', reason: 'unknown-model' })
  ledger.record(fact({ callId: 'flash', model: 'deepseek-flash' }), priced)
  ledger.record(fact({ callId: 'glm', provider: 'zai-coding-cn', model: 'glm-5.3' }), { status: 'unpriced', reason: 'no-schedule' })

  assert.deepEqual(
    ledger.unpricedModels(['deepseek-official']),
    [{ provider: 'deepseek-official', model: 'deepseek-v5', calls: 2, lastSeenAt: 500, reason: 'unknown-model' }],
    'a priced route missing one rate is a gap; a plan-priced vendor is not',
  )
  assert.deepEqual(
    ledger.unpricedModels().map((entry) => entry.model).sort(),
    ['deepseek-v5', 'glm-5.3'],
    'and a caller that names no route sees every unpriced model, with its reason',
  )
  await ledger.close()
})

const DAY = 86_400_000
/** 2026-06-01 12:00 UTC, far outside a 90-day window from the shared clock. */
const OLD = Date.UTC(2026, 5, 1, 12, 0)
/** The shared "now": 2026-09-15 20:00 UTC. */
const TODAY = Date.UTC(2026, 8, 15, 20, 0)

/**
 * A ledger worth compacting: old calls across two routes, two models and two
 * currencies, plus calls inside the window.
 */
async function compactableLedger(retentionDays = 90) {
  const path = await ledgerPath()
  let sequence = 0
  const ledger = new UsageLedger({ path, now: () => TODAY, retentionDays })
  await ledger.open()
  const add = (overrides, quote) => {
    sequence += 1
    ledger.record(fact({
      callId: `fact-${sequence}`,
      sessionId: overrides.startedAt === TODAY ? 's1' : 'old-session',
      usage: { inputTokens: 1_000, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 100 },
      ...overrides,
    }), quote)
  }
  add({ startedAt: OLD, provider: 'deepseek-official', model: 'deepseek-flash' }, priced)
  add({ startedAt: OLD + 1, provider: 'deepseek-official', model: 'deepseek-flash' }, priced)
  add({ startedAt: OLD + 2, provider: 'deepseek-official', model: 'deepseek-v5' }, { status: 'unpriced', reason: 'unknown-model' })
  // One old call billed in another currency, so a rollup has to keep amounts
  // per currency instead of one blended number.
  add({ startedAt: OLD + 3, provider: 'deepseek-official', model: 'deepseek-flash' }, { status: 'priced', currency: 'USD', amountMicros: 500 })
  add({ startedAt: TODAY, provider: 'deepseek-official', model: 'deepseek-flash' }, priced)
  return { ledger, path }
}

test('compaction folds old days without moving a single total', async () => {
  const { ledger, path } = await compactableLedger()
  const before = {
    all: ledger.summary('all'),
    scoped: ledger.summary('all', 'deepseek-official'),
    today: ledger.summary('today'),
    todayScoped: ledger.summary('today', 'deepseek-official'),
  }
  await ledger.close()

  const reopened = new UsageLedger({ path, now: () => TODAY, retentionDays: 90 })
  await reopened.open()
  const after = {
    all: reopened.summary('all'),
    scoped: reopened.summary('all', 'deepseek-official'),
    today: reopened.summary('today'),
    todayScoped: reopened.summary('today', 'deepseek-official'),
  }
  assert.deepEqual(after.all, before.all, 'every total survives the fold: calls, buckets, reasoning, per-currency money')
  assert.deepEqual(after.scoped, before.scoped)
  assert.deepEqual(after.today, before.today)
  assert.deepEqual(after.todayScoped, before.todayScoped)

  const rollups = reopened.entries.filter((entry) => entry.rollup === true)
  assert.equal(rollups.length, 2, 'one rollup per day and route: the priced flash pair and the unpriced v5 call')
  const flash = rollups.find((entry) => entry.model === 'deepseek-flash')
  assert.equal(flash.calls, 3, 'three old flash calls, two CNY and one USD')
  assert.equal(flash.usage.inputTokens, 3_000)
  assert.deepEqual(flash.amountMicrosByCurrency, { CNY: 2 * 1_000_000, USD: 500 }, 'amounts stay per currency, summed as integers')
  assert.equal(rollups.find((entry) => entry.model === 'deepseek-v5').calls, 1)
  await reopened.close()
})

test('the retention boundary keeps the newest side, and 0 keeps everything', () => {
  // A compactable ledger whose oldest fact sits exactly on the boundary.
  const boundary = TODAY - 90 * DAY
  const ledger = new UsageLedger({ path: join(tmpdir(), `usage-ledger-boundary-${Math.random()}.json`), now: () => TODAY, retentionDays: 90 })
  ledger.open()
  ledger.record(fact({ callId: 'on-boundary', startedAt: boundary }), priced)
  ledger.record(fact({ callId: 'older', startedAt: boundary - 1 }), priced)
  const rolled = ledger.compact()
  assert.equal(rolled.rolled, 1, 'a fact exactly retentionDays old is still raw')
  assert.ok(ledger.entries.some((entry) => entry.fact?.callId === 'on-boundary'))
  assert.equal(ledger.compact().rolled, 0, 'compacting twice folds nothing more')

  const forever = new UsageLedger({ path: join(tmpdir(), `usage-ledger-forever-${Math.random()}.json`), now: () => TODAY, retentionDays: 0 })
  forever.open()
  forever.record(fact({ callId: 'ancient', startedAt: OLD }), priced)
  assert.equal(forever.compact().rolled, 0, '0 means every fact stays exactly as it happened')
})

test('a rolled session loses its detail, and unpriced naming follows the raw window', async () => {
  const { ledger, path } = await compactableLedger()
  assert.equal(ledger.sessionSummary('old-session').calls, 4)
  await ledger.close()

  const reopened = new UsageLedger({ path, now: () => TODAY, retentionDays: 90 })
  await reopened.open()
  assert.equal(reopened.sessionSummary('old-session').calls, 0, 'rollups carry no session: detail has the window as its horizon')
  assert.deepEqual(reopened.unpricedModels(['deepseek-official']), [], 'an old unpriced call is history, not a gap the operator can still close')
  assert.deepEqual(reopened.summary('all').byModel['deepseek-v5'].calls, 1, 'but its tokens stay in every window total')
  await reopened.close()
})

test('a v1 file still loads, and the next write upgrades it', async () => {
  const path = await ledgerPath()
  await writeFile(path, JSON.stringify({
    schemaVersion: 1,
    updatedAt: 1,
    entries: [{ callId: 'legacy', fact: fact({ callId: 'legacy' }), quote: priced }],
  }))
  const ledger = new UsageLedger({ path, now: () => TODAY, retentionDays: 90 })
  await ledger.open()
  assert.equal(ledger.summary('all').calls, 1, 'a v1 file is read exactly as v1 read it')
  ledger.record(fact({ callId: 'fresh', startedAt: TODAY }), priced)
  await ledger.flush()
  assert.equal(JSON.parse(await readFile(path, 'utf8')).schemaVersion, 2, 'the next write lands as v2')
  await ledger.close()
})
