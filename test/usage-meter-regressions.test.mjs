/**
 * Regressions found by the second-round audit of the built-in meter.
 *
 * Each test names the defect it pins down: a contract rate multiplied twice, a
 * peak band that was never selected, a peak-only entry that crashed metering,
 * agreement dates that excluded their own last day, a ledger entry that turned
 * every later summary into a failure, provider or model names that reached
 * `Object.prototype`, a nested call billed twice, and settings that were either
 * shown in the wrong units or written over a newer file.
 *
 * @module dsh-provider-openai-subscription/test/usage-meter-regressions
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { UsageLedger } from '../src/usage/ledger.js'
import { UsageMeterService } from '../src/usage/service.js'
import { MeterSettingsStore } from '../src/usage/settings-store.js'
import { toContractualSchedule } from '../src/usage/config.js'
import { createUsageCollector } from '../src/usage/collector.js'
import { PEAK_WINDOWS, UNPRICED_MISSING_BAND, quoteUsage, scheduleCovers } from '../src/usage/pricing.js'

/** Beijing 09:30 on a Tuesday: inside the official peak window. */
const PEAK = Date.UTC(2026, 8, 15, 1, 30)
/** Beijing 04:00 the same day: outside every peak window. */
const OFF_PEAK = Date.UTC(2026, 8, 14, 20, 0)

/** One DeepSeek call in the shape the collector records. */
function fact(overrides = {}) {
  return {
    callId: 'call-1',
    provider: 'deepseek-official',
    model: 'deepseek-flash',
    sessionId: 's1',
    startedAt: OFF_PEAK,
    completedAt: OFF_PEAK + 1,
    usage: { inputTokens: 1_000_000, outputTokens: 0 },
    ...overrides,
  }
}

/** A fresh directory for one test's files. */
function freshDir() {
  return mkdtemp(join(tmpdir(), 'usage-regressions-'))
}

/** A flat USD agreement at 0.1 per million uncached input tokens. */
const FLAT_CONTRACT = {
  id: 'acme',
  currency: 'USD',
  models: { 'deepseek-flash': { cacheMiss: 0.1, cacheHit: 0.001, output: 0.2 } },
}

test('saving through the store does not multiply contract rates a second time', async () => {
  const dir = await freshDir()
  const store = new MeterSettingsStore({ path: join(dir, 'settings.json'), base: {}, now: () => 1 })
  await store.open()
  const ledger = new UsageLedger({ path: join(dir, 'usage.json'), debounceMs: 1, now: () => 1 })
  await ledger.open()
  const service = new UsageMeterService({ ledger, config: store.raw(), now: () => OFF_PEAK })

  const saved = await store.update({ accountKind: 'enterprise', contractualSchedules: [FLAT_CONTRACT] }, 0)
  service.updateConfig(saved.raw)

  const quote = service.recordUsage(fact({ callId: 'after-save' })).quote
  assert.equal(quote.status, 'priced')
  assert.equal(quote.currency, 'USD')
  assert.equal(quote.amountMicros, 100_000, '0.1 USD per million tokens, not 10^6 times that')
  await ledger.close()
})

test('a contract prices a peak-hour call at its peak rate', () => {
  const schedule = toContractualSchedule({
    currency: 'USD',
    models: {
      'deepseek-flash': {
        offPeak: { cacheMiss: 0.1, cacheHit: 0.001, output: 0.2 },
        peak: { cacheMiss: 0.9, cacheHit: 0.009, output: 1.8 },
      },
    },
  })
  assert.notEqual(schedule, undefined)

  const peak = quoteUsage({ model: 'deepseek-flash', startedAt: PEAK, usage: { inputTokens: 1_000_000, outputTokens: 0 } }, schedule)
  assert.equal(peak.band, 'peak', 'an agreement states prices per band, so the band has to be selected')
  assert.equal(peak.amountMicros, 900_000)

  const offPeak = quoteUsage({ model: 'deepseek-flash', startedAt: OFF_PEAK, usage: { inputTokens: 1_000_000, outputTokens: 0 } }, schedule)
  assert.equal(offPeak.band, 'offPeak')
  assert.equal(offPeak.amountMicros, 100_000)
})

test('an entry that names only a peak band is dropped, and a missing band is unpriced, never fatal', () => {
  const peakOnly = { currency: 'USD', models: { 'deepseek-flash': { peak: { cacheMiss: 1, cacheHit: 0.1, output: 2 } } } }
  assert.equal(toContractualSchedule(peakOnly), undefined, 'no off-peak rate means no price for most of the day')

  // Handed such a schedule directly, the peak call is priced while the off-peak
  // one cannot be: the answer must be "unpriced" rather than a crash whose
  // failure the caller swallows, losing the call entirely.
  const schedule = {
    id: 'peak-only',
    currency: 'USD',
    windows: PEAK_WINDOWS,
    models: { m: { peak: { cacheMiss: 1, cacheHit: 1, output: 1 } } },
  }
  const peak = quoteUsage({ model: 'm', startedAt: PEAK, usage: { inputTokens: 1, outputTokens: 0 } }, schedule)
  assert.equal(peak.status, 'priced')

  const offPeak = quoteUsage({ model: 'm', startedAt: OFF_PEAK, usage: { inputTokens: 1, outputTokens: 0 } }, schedule)
  assert.equal(offPeak.status, 'unpriced')
  assert.equal(offPeak.reason, UNPRICED_MISSING_BAND)
  assert.equal(offPeak.amountMicros, undefined)
})

test('an agreement end date covers its whole day, and a broken date drops the entry', () => {
  const schedule = toContractualSchedule({ ...FLAT_CONTRACT, validFrom: '2026-01-01', validTo: '2026-12-31' })
  assert.notEqual(schedule, undefined)
  assert.equal(scheduleCovers(schedule, Date.parse('2026-01-01T00:00:00Z')), true, 'the first day starts at midnight')
  assert.equal(scheduleCovers(schedule, Date.parse('2026-12-31T10:00:00Z')), true, 'the last day is still covered')
  assert.equal(scheduleCovers(schedule, Date.parse('2027-01-01T00:00:00Z')), false)

  assert.equal(
    toContractualSchedule({ ...FLAT_CONTRACT, validTo: '2026-13-45' }),
    undefined,
    'a mistyped end date must not make an agreement permanent',
  )
  assert.equal(toContractualSchedule({ ...FLAT_CONTRACT, validFrom: 'yesterday' }), undefined)
})

test('the editor sees user units while pricing sees micro units', async () => {
  const dir = await freshDir()
  const path = join(dir, 'settings.json')
  const store = new MeterSettingsStore({ path, base: {}, now: () => 1 })
  await store.open()
  await store.update({ contractualSchedules: [FLAT_CONTRACT] }, 0)

  assert.equal(store.editable().contractualSchedules[0].models['deepseek-flash'].cacheMiss, 0.1)
  assert.equal(store.resolved().contractualSchedules[0].models['deepseek-flash'].offPeak.cacheMiss, 100_000)
})

test('settings written by a newer build are left untouched and never overwritten', async () => {
  const dir = await freshDir()
  const path = join(dir, 'settings.json')
  const newer = JSON.stringify({ schemaVersion: 99, revision: 5, user: { accountKind: 'enterprise' } })
  await writeFile(path, newer)

  const store = new MeterSettingsStore({ path, base: {}, now: () => 1 })
  await store.open()
  assert.equal(store.foreignVersion, 99)
  await assert.rejects(() => store.update({ hideCost: true }, 0), (error) => error.code === 'settings-version')
  assert.equal(await readFile(path, 'utf8'), newer, 'the newer file is exactly as it was')
})

test('an entry that cannot be summed quarantines the ledger instead of failing every later read', async () => {
  const dir = await freshDir()
  const path = join(dir, 'usage.json')
  await writeFile(path, JSON.stringify({
    schemaVersion: 1,
    entries: [{ fact: { callId: 'x', startedAt: 1 }, quote: { status: 'priced', currency: 'CNY', amountMicros: 1 } }],
  }))

  const ledger = new UsageLedger({ path, now: () => 42 })
  await assert.rejects(() => ledger.open())
  await assert.rejects(() => readFile(path, 'utf8'), 'the unreadable ledger is moved aside')
  const kept = await readdir(dir)
  assert.equal(kept.some((name) => name.includes('corrupt')), true, 'the original bytes are preserved')
})

test('provider and model names cannot reach the prototype', async () => {
  const dir = await freshDir()
  const ledger = new UsageLedger({ path: join(dir, 'usage.json'), debounceMs: 1, now: () => 1 })
  await ledger.open()
  ledger.record(fact({ callId: 'proto', model: '__proto__' }), { status: 'priced', currency: 'CNY', amountMicros: 5 })
  ledger.record(fact({ callId: 'ctor', model: 'constructor' }), { status: 'priced', currency: 'CNY', amountMicros: 5 })

  const summary = ledger.summary('all')
  assert.equal(summary.calls, 2)
  assert.equal(summary.usage.inputTokens, 2_000_000)
  assert.equal(Object.hasOwn(summary.byModel, '__proto__'), true)
  assert.equal(Object.prototype.calls, undefined, 'no bucket may be written onto Object.prototype')
  assert.equal(Object.prototype.amountMicros, undefined)
  await ledger.close()
})

test('two instances sharing one home keep each other’s facts', async () => {
  const dir = await freshDir()
  const path = join(dir, 'usage.json')
  const quote = { status: 'priced', currency: 'CNY', amountMicros: 1 }

  // Both open the same empty file, so neither snapshot can contain the other's
  // fact. A long debounce keeps every write explicit.
  const first = new UsageLedger({ path, debounceMs: 60_000, now: () => 1 })
  const second = new UsageLedger({ path, debounceMs: 60_000, now: () => 2 })
  await first.open()
  await second.open()

  first.record(fact({ callId: 'first-1' }), quote)
  await first.flush()
  second.record(fact({ callId: 'second-1' }), quote)
  await second.flush()

  const reopened = new UsageLedger({ path, debounceMs: 60_000, now: () => 3 })
  const loaded = await reopened.open()
  assert.equal(loaded.facts, 2, 'the second writer merges instead of replacing the file')
  assert.equal(reopened.summary('all').calls, 2)

  await first.close()
  await second.close()
  await reopened.close()
})

test('a call id recorded by both instances stays a single fact', async () => {
  const dir = await freshDir()
  const path = join(dir, 'usage.json')
  const quote = { status: 'priced', currency: 'CNY', amountMicros: 1 }
  const first = new UsageLedger({ path, debounceMs: 60_000, now: () => 1 })
  const second = new UsageLedger({ path, debounceMs: 60_000, now: () => 2 })
  await first.open()
  await second.open()

  first.record(fact({ callId: 'shared' }), quote)
  await first.flush()
  second.record(fact({ callId: 'shared' }), quote)
  await second.flush()

  const reopened = new UsageLedger({ path, debounceMs: 60_000, now: () => 3 })
  assert.equal((await reopened.open()).facts, 1, 'a duplicate call id is not billed twice')
  await first.close()
  await second.close()
  await reopened.close()
})

test('a ledger that becomes unreadable under a writer is moved aside, not overwritten', async () => {
  const dir = await freshDir()
  const path = join(dir, 'usage.json')

  const ledger = new UsageLedger({ path, debounceMs: 60_000, now: () => 7 })
  await ledger.open()
  // Another instance leaves something this build cannot parse between our open
  // and our write; the merge must preserve it rather than clobber it.
  await writeFile(path, 'not json at all')

  ledger.record(fact({ callId: 'after-foreign' }), { status: 'priced', currency: 'CNY', amountMicros: 1 })
  await ledger.flush()

  const names = await readdir(dir)
  assert.equal(names.some((name) => name.includes('corrupt')), true, 'the unreadable file is preserved')
  const written = JSON.parse(await readFile(path, 'utf8'))
  assert.equal(written.entries.length, 1, 'this instance still writes what it holds')
  await ledger.close()
})
test('dispatch runs inside the meter-depth marker, so a router re-entry is not billed twice', () => {
  const collector = createUsageCollector({ record: () => {} })
  const plain = () => (async function* () {})()
  let nestedReturnedUnwrapped
  collector({ provider: 'deepseek-official', model: 'outer' }, () => {
    const marker = plain()
    nestedReturnedUnwrapped = collector({ provider: 'deepseek-official', model: 'inner' }, () => marker) === marker
    return plain()
  })
  assert.equal(nestedReturnedUnwrapped, true, 'a call started while dispatching belongs to the outer record')
})

test('a read with no balance reading asks for one, so the sidebar can show it', async () => {
  const dir = await freshDir()
  const ledger = new UsageLedger({ path: join(dir, 'usage.json'), debounceMs: 60_000, now: () => 1 })
  await ledger.open()
  let calls = 0
  const meter = new UsageMeterService({
    ledger,
    now: () => 1_000,
    balanceTtlMs: 0,
    readDeepSeekCredential: async () => ({ apiKey: 'sk-test' }),
    fetchImpl: async () => {
      calls += 1
      return new Response(JSON.stringify({
        is_available: true,
        balance_infos: [{ currency: 'CNY', total_balance: '12.30', granted_balance: '2.30', topped_up_balance: '10.00' }],
      }), { status: 200 })
    },
  })

  const before = meter.view({ sessionId: 's1' })
  assert.equal(before.deepseek.status, 'idle', 'nothing has been read yet')
  assert.equal(before.deepseek.primary, undefined, 'and so there is no balance to show')

  await new Promise((resolve) => { setTimeout(resolve, 5) })
  assert.equal(calls, 1, 'the read path asked for the first reading instead of waiting for a button')

  const after = meter.view({ sessionId: 's1' })
  assert.equal(after.deepseek.status, 'ok')
  assert.equal(after.deepseek.primary.currency, 'CNY')
  assert.equal(after.deepseek.primary.total, 12.3)
  await ledger.close()
})

test('the settings switch can forbid the outbound balance request entirely', async () => {
  const dir = await freshDir()
  const ledger = new UsageLedger({ path: join(dir, 'usage.json'), debounceMs: 60_000, now: () => 1 })
  await ledger.open()
  let calls = 0
  const meter = new UsageMeterService({
    ledger,
    config: { deepseekBalance: false },
    now: () => 1_000,
    readDeepSeekCredential: async () => ({ apiKey: 'sk-test' }),
    fetchImpl: async () => {
      calls += 1
      return new Response('{}', { status: 200 })
    },
  })

  const balance = await meter.refreshDeepSeekBalance({ force: true })
  assert.equal(balance.status, 'off', 'a disabled reading reports itself as off, not as a failure')
  meter.view({ sessionId: 's1' })
  await new Promise((resolve) => { setTimeout(resolve, 5) })
  assert.equal(calls, 0, 'no request is made, not even by the read path')
  assert.equal(meter.view({ sessionId: 's1' }).deepseek.status, 'off')
  await ledger.close()
})

test('totals belong to the route they describe, never to every route at once', async () => {
  const dir = await freshDir()
  const ledger = new UsageLedger({ path: join(dir, 'usage.json'), debounceMs: 60_000, now: () => OFF_PEAK })
  await ledger.open()
  const meter = new UsageMeterService({ ledger, now: () => OFF_PEAK })

  // One session that switched routes: a priced DeepSeek call, then a GLM call and
  // an OpenAI call the same day, neither of which publishes a token price.
  meter.recordUsage(fact({ callId: 'ds-1', usage: { inputTokens: 1_000_000, outputTokens: 0 } }))
  meter.recordUsage(fact({ callId: 'glm-1', provider: 'zai-coding-cn', model: 'glm-5.3', usage: { inputTokens: 500, outputTokens: 100 } }))
  meter.recordUsage(fact({ callId: 'oai-1', provider: 'openai-subscription', model: 'gpt-5.4', usage: { inputTokens: 700, outputTokens: 50 } }))

  const glm = meter.view({ sessionId: 's1', provider: 'zai-coding-cn' })
  assert.equal(glm.usage.session.calls, 1, 'only the GLM call belongs to the GLM reading')
  assert.equal(glm.usage.session.usage.inputTokens, 500)
  assert.equal(glm.usage.today.usage.inputTokens, 500, 'another route tokens stay out of today')
  assert.equal(glm.usage.month.usage.inputTokens, 500)
  assert.equal(glm.usage.today.amountMicros, undefined, 'a coding plan has no cash price to add')

  const deepseek = meter.view({ sessionId: 's1', provider: 'deepseek-official' })
  assert.equal(deepseek.usage.session.usage.inputTokens, 1_000_000)
  assert.equal(deepseek.usage.today.usage.inputTokens, 1_000_000)
  assert.equal(deepseek.usage.today.amountMicros, 1_000_000, 'the priced route still reports its own money')
  assert.equal(deepseek.usage.today.amountCurrency, 'CNY')

  const everything = meter.view({ sessionId: 's1' })
  assert.equal(
    everything.usage.today.usage.inputTokens,
    1_000_000 + 500 + 700,
    'a read that names no route still asks about all of them',
  )
  assert.equal(everything.usage.session.calls, 3, 'and the session totals stay complete for the whole log')
  await ledger.close()
})
