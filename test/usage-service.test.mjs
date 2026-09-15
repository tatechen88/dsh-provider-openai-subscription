/**
 * Unified usage meter service and configuration contracts.
 *
 * @module dsh-provider-openai-subscription/test/usage-service
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { UsageLedger } from '../src/usage/ledger.js'
import { UsageMeterService } from '../src/usage/service.js'
import { LearnedPriceStore } from '../src/usage/pricing-store.js'
import { normalizeMeterConfig, priceToMicros, toContractualSchedule } from '../src/usage/config.js'
import { DEEPSEEK_PUBLIC_SCHEDULE, UNPRICED_NO_SCHEDULE } from '../src/usage/pricing.js'

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
  // Reading the vendor's price page is the one outbound request that is not about
  // the account's own state, so it stays off unless a deployment asks for it.
  assert.equal(normalizeMeterConfig({}).refreshPublicPrices, false)
  assert.equal(normalizeMeterConfig({ refreshPublicPrices: true }).refreshPublicPrices, true)
})

/**
 * A price page in the shape the real one uses: one model column, six rates.
 * @param {string} model
 * @param {string} cacheMiss
 * @returns {string}
 */
function pricePage(model, cacheMiss) {
  return `<table>
<tr><td colspan="3" style="text-align:center">模型</td><td>${model}<sup>(1)</sup></td></tr>
<tr><td rowspan="6">价格<sup>(3)</sup></td><td rowspan="2">百万tokens输入<br>（缓存命中）</td><td>空闲时段</td><td>0.02元</td></tr>
<tr><td>高峰时段</td><td>0.04元</td></tr>
<tr><td rowspan="2">百万tokens输入<br>（缓存未命中）</td><td>空闲时段</td><td>${cacheMiss}</td></tr>
<tr><td>高峰时段</td><td>2元</td></tr>
<tr><td rowspan="2">百万tokens输出</td><td>空闲时段</td><td>4元</td></tr>
<tr><td>高峰时段</td><td>8元</td></tr></table>
<p>(3) 空闲时段价格为高峰时段价格的一半。高峰时段为北京时间周一至周五 9:00 - 12:00、14:00 - 18:00（其余为空闲时段）。</p>`
}

/** A learned price store beside one test's ledger. */
async function priceStoreFor(ledger) {
  const store = new LearnedPriceStore({ path: join(dirname(ledger.path), 'prices.json'), now: () => NOW })
  assert.deepEqual(await store.open(), { loaded: false })
  return store
}

test('a learned price table prices the model the snapshot does not carry', async () => {
  const ledger = await openedLedger()
  const store = await priceStoreFor(ledger)
  const meter = new UsageMeterService({
    ledger,
    now: () => NOW,
    pricingStore: store,
    config: { refreshPublicPrices: true },
    fetchImpl: async () => new Response(pricePage('deepseek-v5', '3元'), { status: 200 }),
  })

  const result = await meter.refreshPublicPrices({ force: true })
  assert.equal(result.status, 'ok', result.reason)
  assert.equal(result.schedule.source, 'official-price-page')
  assert.equal(result.schedule.windowSource, 'page')
  assert.deepEqual(result.schedule.models['deepseek-v5'].offPeak, { cacheHit: 20_000, cacheMiss: 3_000_000, output: 4_000_000 })

  const schedules = meter.publicSchedules()
  assert.equal(schedules.length, 2, 'the learned table sits in front of the one this build ships')
  assert.deepEqual(schedules[0], result.schedule)
  assert.equal(schedules[1].id, DEEPSEEK_PUBLIC_SCHEDULE.id)

  const shipped = meter.recordUsage(fact({ callId: 'v5', model: 'deepseek-v5' })).quote
  assert.equal(shipped.status, 'priced', 'the page carries this model, so it is priced from the page')
  assert.equal(shipped.amountMicros, 3_000_000)

  const known = meter.recordUsage(fact({ callId: 'flash', model: 'deepseek-flash' })).quote
  assert.equal(known.status, 'priced')
  assert.equal(known.amountMicros, 1_000_000, 'a model only the built-in table carries still resolves')

  const view = meter.view({ provider: 'deepseek-official' })
  assert.equal(view.pricing.public.scheduleId, result.schedule.id)
  assert.equal(view.pricing.public.fallbackScheduleId, DEEPSEEK_PUBLIC_SCHEDULE.id)
  assert.deepEqual(view.pricing.unpricedModels, [], 'and nothing is left unpriced')
  await ledger.close()
})

test('a page that does not parse leaves the table in force and says why', async () => {
  const ledger = await openedLedger()
  const store = await priceStoreFor(ledger)
  const meter = new UsageMeterService({
    ledger,
    now: () => NOW,
    pricingStore: store,
    config: { refreshPublicPrices: true },
    fetchImpl: async () => new Response('<table><tr><td>模型</td></tr></table>', { status: 200 }),
  })

  const result = await meter.refreshPublicPrices({ force: true })
  assert.equal(result.status, 'unreadable')
  assert.equal(store.schedule, undefined, 'nothing is adopted from a table that did not parse')
  assert.equal(store.lastError, result.reason)

  const view = meter.view({ provider: 'deepseek-official' })
  assert.equal(view.pricing.public.scheduleId, DEEPSEEK_PUBLIC_SCHEDULE.id, 'the built-in table keeps pricing calls')
  assert.equal(view.pricing.public.fallbackScheduleId, DEEPSEEK_PUBLIC_SCHEDULE.id)
  assert.deepEqual(view.pricing.refresh, { enabled: true, lastAttemptAt: NOW, lastError: result.reason })
  await ledger.close()
})

test('the price page is read only when a deployment asks for it', async () => {
  const ledger = await openedLedger()
  const store = await priceStoreFor(ledger)
  let calls = 0
  const meter = new UsageMeterService({
    ledger,
    now: () => NOW,
    pricingStore: store,
    fetchImpl: async () => { calls += 1; return new Response(pricePage('deepseek-v5', '3元'), { status: 200 }) },
  })

  assert.deepEqual(await meter.refreshPublicPrices(), { status: 'off', reason: 'disabled' })
  // An unpriced model is the moment worth reading the page, but only when the
  // deployment turned that on: the request stays out of the default deployment.
  meter.recordUsage(fact({ callId: 'v5', model: 'deepseek-v5' }))
  await new Promise((resolve) => { setTimeout(resolve, 5) })
  assert.equal(calls, 0)
  assert.equal(meter.view().pricing.refresh.enabled, false, 'and the page can say the switch is off')
  await ledger.close()
})

test('an unpriced model asks for the page once, and the attempt backs off', async () => {
  const ledger = await openedLedger()
  const store = await priceStoreFor(ledger)
  let calls = 0
  const meter = new UsageMeterService({
    ledger,
    now: () => NOW,
    pricingStore: store,
    config: { refreshPublicPrices: true },
    fetchImpl: async () => { calls += 1; return new Response(pricePage('deepseek-v5', '3元'), { status: 200 }) },
  })

  meter.recordUsage(fact({ callId: 'v5-a', model: 'deepseek-v5' }))
  await new Promise((resolve) => { setTimeout(resolve, 5) })
  assert.equal(calls, 1, 'an unpriced call starts exactly one read')
  assert.equal(store.schedule.models['deepseek-v5'].offPeak.cacheMiss, 3_000_000)

  meter.recordUsage(fact({ callId: 'v5-b', model: 'deepseek-v5' }))
  await new Promise((resolve) => { setTimeout(resolve, 5) })
  assert.equal(calls, 1, 'a recent attempt is not repeated on every unpriced call')
  assert.deepEqual(await meter.refreshPublicPrices(), { status: 'not-due' })

  // The model the page now covers stops being unpriced on the next call.
  const priced = meter.recordUsage(fact({ callId: 'v5-c', model: 'deepseek-v5' })).quote
  assert.equal(priced.status, 'priced')
  await ledger.close()
})

test('an explicit refresh waits out a short cooldown before reading again', async () => {
  const ledger = await openedLedger()
  const store = await priceStoreFor(ledger)
  let calls = 0
  const meter = new UsageMeterService({
    ledger,
    now: () => NOW,
    pricingStore: store,
    config: { refreshPublicPrices: true },
    fetchImpl: async () => { calls += 1; return new Response(pricePage('deepseek-v5', '3元'), { status: 200 }) },
  })

  assert.equal((await meter.refreshPublicPrices({ force: true })).status, 'ok')
  assert.equal(calls, 1)

  // A repeated explicit call inside the cooldown is answered without touching
  // the vendor's page: `force` skips the day-long TTL, not this floor, or the
  // refresh route would become a hammer by way of the flag meant to bypass one.
  assert.deepEqual(
    await meter.refreshPublicPrices({ force: true }),
    { status: 'cooldown', reason: 'the last attempt was less than 60s ago' },
  )
  assert.equal(calls, 1)
  await ledger.close()
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
