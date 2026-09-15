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
