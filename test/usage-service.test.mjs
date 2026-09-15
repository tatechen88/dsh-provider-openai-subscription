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
import { UsageLedger } from '../src/usage/ledger.js'
import { UsageMeterService } from '../src/usage/service.js'
import { normalizeMeterConfig, priceToMicros, toContractualSchedule } from '../src/usage/config.js'
import { UNPRICED_NO_SCHEDULE } from '../src/usage/pricing.js'

/** Frozen clock shared by the ledger and the meter, so periods are comparable. */
const NOW = Date.UTC(2026, 8, 15, 20, 30)

/** An opened ledger in a fresh directory, on the shared clock. */
async function openedLedger(name = 'usage.json') {
  const dir = await mkdtemp(join(tmpdir(), 'usage-service-'))
  const ledger = new UsageLedger({ path: join(dir, name), debounceMs: 1, now: () => NOW })
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

/** A resolvable DeepSeek key, as the credential service would return it. */
const readDeepSeekCredential = async () => ({ apiKey: 'sk-test' })

test('meter configuration falls back per field instead of failing', () => {
  assert.equal(normalizeMeterConfig(undefined).accountKind, 'unknown')
  assert.equal(normalizeMeterConfig({ accountKind: 'enterprise' }).accountKind, 'enterprise')
  assert.equal(normalizeMeterConfig({ accountKind: 'root' }).accountKind, 'unknown')
  assert.equal(normalizeMeterConfig({ timeZone: 'Mars/Olympus' }).timeZone, 'system')
  assert.equal(normalizeMeterConfig({ timeZone: 'Asia/Shanghai' }).timeZone, 'Asia/Shanghai')
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

test('an OpenAI call shares the window but never carries DeepSeek money', async () => {
  const ledger = await openedLedger()
  const meter = new UsageMeterService({ ledger, now: () => NOW })

  const subscription = meter.recordUsage(fact({
    callId: 'call-openai',
    provider: 'openai-subscription',
    model: 'gpt-5',
    usage: { inputTokens: 500, outputTokens: 100 },
  }))
  assert.equal(subscription.stored, true)
  assert.equal(subscription.quote.status, 'unpriced', 'a subscription call is not billed by the DeepSeek table')

  assert.equal(meter.recordUsage(fact({ callId: 'call-deepseek' })).quote.amountMicros, 1_000_000)

  const view = meter.view({ sessionId: 's1' })
  assert.equal(view.usage.session.calls, 2, 'both providers count into one session window')
  assert.equal(view.usage.session.usage.inputTokens, 1_000_500)
  assert.equal(view.usage.session.usage.outputTokens, 100)
  assert.deepEqual(view.usage.session.amountsMicrosByCurrency, { CNY: 1_000_000 }, 'only the priced call carries money')
  assert.equal(view.usage.session.amountMicros, 1_000_000)
  await ledger.close()
})

test('a rate table never prices another provider, even on a matching model name', async () => {
  const ledger = await openedLedger()
  const meter = new UsageMeterService({ ledger, now: () => NOW })

  const quote = meter.recordUsage(fact({
    callId: 'call-collision',
    provider: 'openai-subscription',
    model: 'deepseek-flash',
  })).quote
  assert.equal(quote.status, 'unpriced', 'a schedule belongs to the provider that published it')
  assert.equal(quote.reason, UNPRICED_NO_SCHEDULE)

  const view = meter.view({ sessionId: 's1' })
  assert.equal(view.usage.session.calls, 1, 'the call is still counted')
  assert.equal(view.usage.session.amountMicros, undefined)
  await ledger.close()
})

test('an enterprise declaration unlocks a configured agreement but changes nothing by itself', async () => {
  const ledger = await openedLedger()
  const contractualSchedules = [{
    id: 'acme',
    label: 'Acme agreement',
    currency: 'USD',
    validFrom: '2026-01-01',
    models: { 'deepseek-flash': { offPeak: { cacheMiss: 0.1, cacheHit: 0.001, output: 0.2 } } },
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

test('an amount is shown in the currency it was billed in, never converted', async () => {
  const ledger = await openedLedger()
  const contractualSchedules = [{
    id: 'acme',
    label: 'Acme agreement',
    currency: 'USD',
    models: { 'deepseek-flash': { offPeak: { cacheMiss: 0.1, cacheHit: 0.001, output: 0.2 } } },
  }]
  const meter = new UsageMeterService({
    ledger,
    config: { accountKind: 'enterprise', contractualSchedules, displayCurrency: 'CNY' },
    now: () => NOW,
  })
  meter.recordUsage(fact())
  // A second call on public prices lands in the same session, in CNY.
  new UsageMeterService({ ledger, now: () => NOW }).recordUsage(fact({ callId: 'call-2' }))

  const session = meter.view({ sessionId: 's1' }).usage.session
  assert.equal(session.amountCurrency, 'CNY', 'the matching currency wins when the ledger holds more than one')
  assert.equal(session.amountMicros, 1_000_000, 'one million uncached tokens at CNY 1.00/M')
  assert.deepEqual(session.amountsMicrosByCurrency, { USD: 100_000, CNY: 1_000_000 })

  const usd = new UsageMeterService({ ledger, config: { displayCurrency: 'USD' }, now: () => NOW })
  assert.equal(usd.view({ sessionId: 's1' }).usage.session.amountMicros, 100_000, 'the agreement amount is reachable by preference')

  const eur = new UsageMeterService({ ledger, config: { displayCurrency: 'EUR' }, now: () => NOW })
  const eurSession = eur.view({ sessionId: 's1' }).usage.session
  assert.equal(eurSession.amountMicros, undefined, 'two billed currencies and no matching preference name no single amount')
  assert.deepEqual(eurSession.amountsMicrosByCurrency, { USD: 100_000, CNY: 1_000_000 }, 'both amounts stay available')
  await ledger.close()
})

test('a sole non-matching currency is still shown as itself rather than hidden', async () => {
  const ledger = await openedLedger('usd-only.json')
  const contractualSchedules = [{
    id: 'acme',
    label: 'Acme agreement',
    currency: 'USD',
    models: { 'deepseek-flash': { offPeak: { cacheMiss: 0.1, cacheHit: 0.001, output: 0.2 } } },
  }]
  const meter = new UsageMeterService({
    ledger,
    config: { accountKind: 'enterprise', contractualSchedules, displayCurrency: 'CNY' },
    now: () => NOW,
  })
  meter.recordUsage(fact())
  const session = meter.view({ sessionId: 's1' }).usage.session
  assert.equal(session.amountCurrency, 'USD', 'a USD agreement under a CNY preference still reports its money')
  assert.equal(session.amountMicros, 100_000)
  await ledger.close()
})

test('a configured agreement is reported in force only when it really prices the call', async () => {
  const ledger = await openedLedger()
  const contractualSchedules = [{
    id: 'acme',
    label: 'Acme agreement',
    currency: 'USD',
    validFrom: '2026-01-01',
    validTo: '2026-12-31',
    models: { 'deepseek-flash': { offPeak: { cacheMiss: 0.1, cacheHit: 0.001, output: 0.2 } } },
  }]

  const personal = new UsageMeterService({ ledger, config: { accountKind: 'personal', contractualSchedules }, now: () => NOW })
  assert.deepEqual(personal.view().pricing.contractual, {
    configured: true,
    active: false,
    label: 'Acme agreement',
    currency: 'USD',
    validTo: '2026-12-31',
  }, 'a personal account may see the agreement but not be told it is billed at it')

  const enterprise = new UsageMeterService({ ledger, config: { accountKind: 'enterprise', contractualSchedules }, now: () => NOW })
  assert.equal(enterprise.view().pricing.contractual.active, true)
  assert.equal(enterprise.view().pricing.contractual.scheduleId, 'acme')

  const later = new UsageMeterService({ ledger, config: { accountKind: 'enterprise', contractualSchedules }, now: () => Date.UTC(2027, 0, 2) })
  assert.equal(later.view().pricing.contractual.active, false, 'an expired agreement is not in force')

  const none = new UsageMeterService({ ledger, now: () => NOW })
  assert.deepEqual(none.view().pricing.contractual, { configured: false, active: false })
  assert.equal(none.view().pricing.public.retrievedAt, '2026-09-15', 'the public snapshot is always named')
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

test('the configuration exposes exactly the switches the settings page renders', () => {
  // `showSidebar` and `showSessionDock` were accepted and never read; they are
  // gone on purpose, because a knob nobody can turn is worse than no knob.
  const config = normalizeMeterConfig({ showSidebar: false, showSessionDock: false })
  assert.equal('showSidebar' in config, false)
  assert.equal('showSessionDock' in config, false)
  // `deepseekBalance` stays: a deployment may forbid the outbound balance
  // request, and the settings page renders this same switch.
  assert.equal(normalizeMeterConfig({ deepseekBalance: false }).deepseekBalance, false)
  assert.equal(normalizeMeterConfig({}).deepseekBalance, true)
  // The auto switch defaults on: a provider another plugin registers is metered
  // without a release here, and turning it off restores the fixed registry.
  assert.equal(normalizeMeterConfig({}).autoProviders, true)
  assert.equal(normalizeMeterConfig({ autoProviders: false }).autoProviders, false)
})

test('the view names the models its price table does not cover', async () => {
  const ledger = await openedLedger()
  const meter = new UsageMeterService({ ledger, now: () => NOW })

  // A model the built-in table does not know, next to one it does and one on a
  // vendor that publishes no table at all.
  meter.recordUsage(fact({ callId: 'new-model', model: 'deepseek-v5' }))
  meter.recordUsage(fact({ callId: 'known-model' }))
  meter.recordUsage(fact({ callId: 'glm', provider: 'zai-coding-cn', model: 'glm-5.3' }))

  assert.deepEqual(
    meter.view({ provider: 'deepseek-official' }).pricing.unpricedModels,
    [{
      provider: 'deepseek-official',
      model: 'deepseek-v5',
      calls: 1,
      lastSeenAt: Date.UTC(2026, 8, 15, 20, 0),
      reason: 'unknown-model',
    }],
    'the card can name the gap a new model leaves behind',
  )
  await ledger.close()
})
