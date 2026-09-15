/**
 * Usage model and price-book contracts.
 *
 * @module dsh-provider-openai-subscription/test/usage-pricing
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  assertUsageFact,
  cacheHitRatio,
  readUsageBuckets,
  validateUsageFact,
} from '../src/usage/types.js'
import {
  DEEPSEEK_PUBLIC_SCHEDULE,
  UNPRICED_UNKNOWN_MODEL,
  buildSchedules,
  isPeakAt,
  quoteUsage,
  resolveSchedule,
} from '../src/usage/pricing.js'

/** A well-formed fact for one DeepSeek call. */
function fact(overrides = {}) {
  return {
    callId: 'call-1',
    provider: 'deepseek-official',
    model: 'deepseek-flash',
    sessionId: 'session-1',
    startedAt: Date.UTC(2026, 8, 15, 0, 0, 0),
    completedAt: Date.UTC(2026, 8, 15, 0, 0, 5),
    usage: { inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 },
    ...overrides,
  }
}

test('usage fact validation accepts a complete fact and rejects invalid counts', () => {
  const good = validateUsageFact(fact())
  assert.equal(good.ok, true)
  assert.equal(good.fact.provider, 'deepseek-official')
  assert.equal(good.fact.usage.cacheWriteReported, true, 'the fixture states a zero cache-write bucket')

  const omitted = validateUsageFact(fact({ usage: { inputTokens: 1, outputTokens: 1 } }))
  assert.equal(omitted.ok, true)
  assert.equal(omitted.fact.usage.cacheWriteReported, false, 'an omitted bucket stays unreported')

  const missing = validateUsageFact({ ...fact(), callId: undefined })
  assert.equal(missing.ok, false)
  assert.ok(missing.errors.includes('callId'))

  const negative = validateUsageFact(fact({ usage: { inputTokens: -1, outputTokens: 0 } }))
  assert.equal(negative.ok, false)
  assert.ok(negative.errors.includes('usage-missing-aggregates'))

  const fractional = validateUsageFact(fact({ usage: { inputTokens: 1.5, outputTokens: 0 } }))
  assert.equal(fractional.ok, false)

  assert.throws(() => assertUsageFact({}), /UsageFact is invalid/)
})

test('an unreported cache bucket is not the same fact as a reported zero', () => {
  const unreported = readUsageBuckets({ inputTokens: 10, outputTokens: 2 })
  assert.equal(unreported.ok, true)
  assert.equal(unreported.report.cacheReadReported, false)
  assert.equal(unreported.buckets.cacheReadTokens, 0)

  const reported = readUsageBuckets({ inputTokens: 10, outputTokens: 2, cacheReadTokens: 0 })
  assert.equal(reported.report.cacheReadReported, true)

  assert.equal(cacheHitRatio({ inputTokens: 25, cacheReadTokens: 75, cacheWriteTokens: 0 }), 0.75)
  assert.equal(cacheHitRatio({ inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }), null)
})

test('peak windows follow the Beijing weekday scheme as half-open ranges', () => {
  // 2026-09-15 is a Tuesday; Beijing is UTC+8 all year.
  assert.equal(isPeakAt(Date.UTC(2026, 8, 15, 1, 0)), true, '09:00 Beijing is inside the morning window')
  assert.equal(isPeakAt(Date.UTC(2026, 8, 15, 0, 59)), false, '08:59 Beijing is off-peak')
  assert.equal(isPeakAt(Date.UTC(2026, 8, 15, 4, 0)), false, '12:00 Beijing closes the morning window')
  assert.equal(isPeakAt(Date.UTC(2026, 8, 15, 6, 0)), true, '14:00 Beijing opens the afternoon window')
  assert.equal(isPeakAt(Date.UTC(2026, 8, 15, 10, 0)), false, '18:00 Beijing closes the afternoon window')
  // 2026-09-19 is a Saturday.
  assert.equal(isPeakAt(Date.UTC(2026, 8, 19, 2, 0)), false, 'weekends are off-peak all day')
})

test('a charge is the exact fixed-point sum of the three billed buckets', () => {
  const schedule = DEEPSEEK_PUBLIC_SCHEDULE
  const quote = quoteUsage(fact({
    startedAt: Date.UTC(2026, 8, 15, 20, 0), // 04:00 Beijing next day: off-peak
    usage: { inputTokens: 1_000_000, cacheReadTokens: 2_000_000, outputTokens: 500_000 },
  }), schedule)
  assert.equal(quote.status, 'priced')
  assert.equal(quote.currency, 'CNY')
  assert.equal(quote.band, 'offPeak')
  assert.equal(quote.amountMicros, 1_000_000 + 40_000 + 2_000_000, 'miss + hit + output micro units')
  assert.equal(quote.estimated, true)
  assert.equal(quote.cacheWriteBilled, false)
  assert.equal(quote.basis, 'request-start-assumption')
})

test('the peak band doubles the off-peak rate from the same snapshot', () => {
  const offPeak = quoteUsage(fact({
    startedAt: Date.UTC(2026, 8, 15, 20, 0),
    usage: { inputTokens: 1_000_000, outputTokens: 0 },
  }), DEEPSEEK_PUBLIC_SCHEDULE)
  const peak = quoteUsage(fact({
    startedAt: Date.UTC(2026, 8, 15, 1, 30), // 09:30 Beijing, a weekday peak window
    usage: { inputTokens: 1_000_000, outputTokens: 0 },
  }), DEEPSEEK_PUBLIC_SCHEDULE)
  assert.equal(offPeak.band, 'offPeak')
  assert.equal(peak.band, 'peak')
  assert.equal(peak.amountMicros, offPeak.amountMicros * 2)
})

test('sub-micro charges round half up exactly once', () => {
  const quote = quoteUsage(fact({
    startedAt: Date.UTC(2026, 8, 15, 20, 0),
    usage: { inputTokens: 0, cacheReadTokens: 25, outputTokens: 0 },
  }), DEEPSEEK_PUBLIC_SCHEDULE)
  // 25 tokens * 20000 micros / 1e6 = 0.5 micro units.
  assert.equal(quote.amountMicros, 1)
})

test('an unknown model is unpriced instead of inheriting a default rate', () => {
  const quote = quoteUsage(fact({ model: 'deepseek-unreleased' }), DEEPSEEK_PUBLIC_SCHEDULE)
  assert.equal(quote.status, 'unpriced')
  assert.equal(quote.reason, UNPRICED_UNKNOWN_MODEL)
  assert.equal(quote.amountMicros, undefined)
})

test('a contractual rate is reachable only for a declared enterprise account', () => {
  const contractual = {
    id: 'acme-2026',
    label: 'Acme agreement',
    provider: 'deepseek-official',
    status: 'contractual',
    currency: 'USD',
    validFrom: '2026-01-01',
    validTo: '2026-12-31',
    models: { 'deepseek-flash': { offPeak: { cacheHit: 1_000, cacheMiss: 100_000, output: 200_000 } } },
  }
  const schedules = buildSchedules({ contractual: [contractual] })
  const at = Date.UTC(2026, 8, 15, 20, 0)

  const personal = resolveSchedule({ provider: 'deepseek-official', model: 'deepseek-flash', at, accountKind: 'personal', schedules })
  assert.equal(personal.id, DEEPSEEK_PUBLIC_SCHEDULE.id, 'a personal account never sees the agreement')

  const enterprise = resolveSchedule({ provider: 'deepseek-official', model: 'deepseek-flash', at, accountKind: 'enterprise', schedules })
  assert.equal(enterprise.id, 'acme-2026')

  const expired = resolveSchedule({
    provider: 'deepseek-official',
    model: 'deepseek-flash',
    at: Date.UTC(2027, 0, 2),
    accountKind: 'enterprise',
    schedules,
  })
  assert.equal(expired.id, DEEPSEEK_PUBLIC_SCHEDULE.id, 'an expired agreement falls back to the public snapshot')

  const quote = quoteUsage(fact({ startedAt: at, usage: { inputTokens: 1_000_000, outputTokens: 0 } }), enterprise)
  assert.equal(quote.currency, 'USD')
  assert.equal(quote.amountMicros, 100_000)
})
