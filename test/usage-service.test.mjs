/**
 * Unified usage meter service and configuration contracts.
 *
 * @module dsh-provider-openai-subscription/test/usage-service
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createUsageLedger } from '../src/usage/ledger.js'
import { UsageMeterService } from '../src/usage/service.js'
import { normalizeMeterConfig, priceToMicros, toContractualSchedule } from '../src/usage/config.js'

/** Frozen clock shared by the ledger and the meter, so periods are comparable. */
const NOW = Date.UTC(2026, 8, 15, 20, 30)

/** An opened ledger in a fresh directory, on the shared clock. */
async function openedLedger(name = 'usage.json') {
  const dir = await mkdtemp(join(tmpdir(), 'usage-service-'))
  const ledger = createUsageLedger({ path: join(dir, name), debounceMs: 1, now: () => NOW })
  await ledger.open()
  return ledger
}

/** One DeepSeek call that started inside an off-peak window. */
function fact(overrides = {}) {
  return {
    callId: 'call-1',
    provider: 'deepseek-official',
    model: 'deepseek-flash',
    sessionId: 's1',
    startedAt: Date.UTC(2026, 8, 15, 20, 0),
    completedAt: Date.UTC(2026, 8, 15, 20, 0, 2),
    usage: { inputTokens: 1_000_000, outputTokens: 0 },
    ...overrides,
  }
}

/** A resolvable DeepSeek credential, as the credential service would return it. */
const readDeepSeekCredential = async () => ({ baseURL: undefined, apiKey: 'sk-test' })

test('meter configuration falls back per field instead of failing', () => {
  assert.equal(normalizeMeterConfig(undefined).accountKind, 'unknown')
  assert.equal(normalizeMeterConfig({ accountKind: 'enterprise' }).accountKind, 'enterprise')
  assert.equal(normalizeMeterConfig({ accountKind: 'root' }).accountKind, 'unknown')
  assert.equal(normalizeMeterConfig({ timeZone: 'Mars/Olympus' }).timeZone, 'system')
  assert.equal(normalizeMeterConfig({ timeZone: 'Asia/Shanghai' }).timeZone, 'Asia/Shanghai')
  assert.equal(normalizeMeterConfig({ deepseekBalance: false }).deepseekBalance, false)
  assert.equal(normalizeMeterConfig({ hideBalance: true }).hideBalance, true)
})

test('a contractual entry without all three rates is dropped', () => {
  assert.equal(priceToMicros(4.5), 4_500_000)
  assert.equal(priceToMicros(-1), undefined)
  assert.equal(priceToMicros('x'), undefined)

  const complete = toContractualSchedule({
    id: 'acme',
    label: 'Acme',
    currency: 'usd',
    validFrom: '2026-01-01',
    models: { 'deepseek-flash': { cacheMiss: 1, cacheHit: 0.1, output: 2 } },
  })
  assert.equal(complete.currency, 'USD')
  assert.equal(complete.models['deepseek-flash'].offPeak.cacheMiss, 1_000_000)

  const partial = toContractualSchedule({ currency: 'USD', models: { m: { cacheMiss: 1 } } })
  assert.equal(partial, undefined, 'a half-specified agreement never prices a call at zero')

  const config = normalizeMeterConfig({ contractualSchedules: [{ currency: 'USD', models: { m: { cacheMiss: 1 } } }] })
  assert.deepEqual(config.contractualSchedules, [])
})

test('recorded calls are priced, persisted and aggregated per session and period', async () => {
  const ledger = await openedLedger()
  const meter = new UsageMeterService({ ledger, now: () => NOW })

  const stored = meter.recordUsage(fact())
  assert.equal(stored.ok, true)
  assert.equal(stored.stored, true)
  assert.equal(stored.quote.status, 'priced')
  assert.equal(stored.quote.amountMicros, 1_000_000, 'one million uncached input tokens at CNY 1.00/M')

  assert.equal(meter.recordUsage(fact()).stored, false, 'a repeated call id is not billed twice')

  const view = meter.view({ sessionId: 's1' })
  assert.equal(view.usage.session.calls, 1)
  assert.equal(view.usage.session.usage.inputTokens, 1_000_000)
  assert.equal(view.usage.session.amountMicros, 1_000_000)
  assert.equal(view.usage.session.amountCurrency, 'CNY')
  assert.equal(view.usage.today.calls, 1)
  assert.equal(view.pricing.estimated, true)
  assert.equal(view.account.kind, 'unknown')
  await ledger.close()
})

test('an invalid fact or an unknown model never breaks the call it observes', async () => {
  const ledger = await openedLedger()
  const meter = new UsageMeterService({ ledger, now: () => 0 })

  const invalid = meter.recordUsage({ callId: 'x' })
  assert.equal(invalid.ok, false)
  assert.ok(typeof invalid.reason === 'string')

  const unknown = meter.recordUsage(fact({ model: 'future-model' }))
  assert.equal(unknown.ok, true)
  assert.equal(unknown.quote.status, 'unpriced')
  const view = meter.view({ sessionId: 's1' })
  assert.equal(view.usage.session.calls, 1, 'tokens are still counted')
  assert.equal(view.usage.session.amountMicros, undefined, 'no money is invented')
  await ledger.close()
})

test('an enterprise declaration unlocks a configured agreement but changes nothing by itself', async () => {
  const ledger = await openedLedger()
  const contractualSchedules = [{
    id: 'acme',
    label: 'Acme agreement',
    currency: 'USD',
    validFrom: '2026-01-01',
    models: { 'deepseek-flash': { offPeak: { cacheMiss: 100_000, cacheHit: 1_000, output: 200_000 } } },
  }]
  const personal = new UsageMeterService({ ledger, config: { accountKind: 'personal', contractualSchedules }, now: () => 0 })
  assert.equal(personal.recordUsage(fact()).quote.currency, 'CNY')

  const enterprise = new UsageMeterService({ ledger, config: { accountKind: 'enterprise', contractualSchedules }, now: () => 0 })
  const quote = enterprise.recordUsage(fact({ callId: 'call-2' })).quote
  assert.equal(quote.currency, 'USD')
  assert.equal(quote.scheduleLabel, 'Acme agreement')
  await ledger.close()
})

test('privacy hides money and balance while tokens stay visible', async () => {
  const ledger = await openedLedger()
  const meter = new UsageMeterService({ ledger, config: { hideCost: true, hideBalance: true }, now: () => 0 })
  meter.recordUsage(fact())
  const view = meter.view({ sessionId: 's1' })
  assert.equal(view.usage.session.amountMicros, undefined)
  assert.deepEqual(view.usage.session.amountsMicrosByCurrency, undefined)
  assert.equal(view.usage.session.usage.inputTokens, 1_000_000, 'token accounting is not private data')
  assert.equal(view.deepseek.hidden, true)
  assert.deepEqual(view.deepseek.infos, [])
  await ledger.close()
})

test('a failed balance refresh keeps the last known good reading', async () => {
  const ledger = await openedLedger()
  let fail = false
  const meter = new UsageMeterService({
    ledger,
    now: () => 1000,
    balanceTtlMs: 0,
    readDeepSeekCredential,
    fetchImpl: async () => {
      if (fail) throw new Error('network down')
      return new Response(JSON.stringify({ is_available: true, balance_infos: [{ currency: 'CNY', total_balance: '12.00' }] }), { status: 200 })
    },
  })

  const ok = await meter.refreshDeepSeekBalance({ force: true })
  assert.equal(ok.status, 'ok')
  assert.equal(ok.primary.total, 12)

  fail = true
  const stale = await meter.refreshDeepSeekBalance({ force: true })
  assert.equal(stale.status, 'stale')
  assert.equal(stale.primary.total, 12, 'a failed refresh does not erase a real balance')
  assert.match(stale.message, /network down/)

  const view = meter.view()
  assert.equal(view.deepseek.status, 'stale')
  await ledger.close()
})

test('concurrent balance refreshes share one request', async () => {
  const ledger = await openedLedger()
  let calls = 0
  const meter = new UsageMeterService({
    ledger,
    now: () => 1000,
    balanceTtlMs: 60_000,
    readDeepSeekCredential,
    fetchImpl: async () => {
      calls += 1
      return new Response(JSON.stringify({ is_available: true, balance_infos: [{ currency: 'CNY', total_balance: '1.00' }] }), { status: 200 })
    },
  })
  await Promise.all([meter.refreshDeepSeekBalance({ force: true }), meter.refreshDeepSeekBalance({ force: true })])
  assert.equal(calls, 1, 'two readers share one upstream request')
  await ledger.close()
})

test('a disabled balance reading never calls the network', async () => {
  const ledger = await openedLedger()
  let called = false
  const meter = new UsageMeterService({
    ledger,
    config: { deepseekBalance: false },
    fetchImpl: async () => {
      called = true
      return new Response('{}', { status: 200 })
    },
  })
  const balance = await meter.refreshDeepSeekBalance({ force: true })
  assert.equal(balance.status, 'off')
  assert.equal(called, false)
  await ledger.close()
})
