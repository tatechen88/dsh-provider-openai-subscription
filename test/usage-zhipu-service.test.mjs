/**
 * Zhipu wiring in the meter service.
 *
 * The account-reading module has its own tests; this file covers what the meter
 * does with it: one request per TTL shared by concurrent callers, last-known-good
 * retention, the route-gated trigger, the privacy slice, and the fact that a GLM
 * call is metered for tokens without a price ever being invented for it.
 *
 * @module dsh-provider-openai-subscription/test/usage-zhipu-service
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { UsageLedger } from '../src/usage/ledger.js'
import { UsageMeterService } from '../src/usage/service.js'
import { METERED_PROVIDERS, VENDORS } from '../src/usage/vendors.js'
import { hostForProvider } from '../src/usage/zhipu-account.js'

/** The real refusal an account without a Coding Plan receives. */
const NO_PLAN = { code: 500, msg: '当前用户不存在coding plan', success: false }

/** The real cash-account report shape. */
const ACCOUNT_REPORT = { code: 200, success: true, data: { availableBalance: 0, totalSpendAmount: 0, creditStatus: 'NOT_OPEN' } }

/** One real resource-package row, trimmed to the fields the meter reads. */
const PACKAGE = {
  tokenBalance: 2_000_000,
  tokensMagnitude: 2_000_000,
  resourcePackageName: '【新用户专享】200万通用模型推理资源包',
  consumeType: 'TOKENS',
  status: 'EFFECTIVE',
  expirationTime: '2026-11-27T02:53:54',
  suitableModel: '适用于通用大模型',
}

/** An opened ledger in a fresh directory. */
async function openedLedger() {
  const dir = await mkdtemp(join(tmpdir(), 'usage-zhipu-service-'))
  const ledger = new UsageLedger({ path: join(dir, 'usage.json'), debounceMs: 60_000, now: () => 1_000 })
  await ledger.open()
  return ledger
}

/**
 * A fetch stub answering the three Zhipu readings, counting every call.
 * @param {object} [options]
 * @param {boolean} [options.failing] - answer nothing, so every reading fails.
 * @returns {{fetchImpl: Function, calls: string[]}}
 */
function zhipuFetch({ failing = false } = {}) {
  const calls = []
  const fetchImpl = async (url) => {
    const path = new URL(url).pathname
    calls.push(path)
    if (failing) return new Response('down', { status: 503 })
    if (path.endsWith('/quota/limit')) return new Response(JSON.stringify(NO_PLAN), { status: 200 })
    if (path.endsWith('/query-customer-account-report')) return new Response(JSON.stringify(ACCOUNT_REPORT), { status: 200 })
    if (path.includes('/tokenAccounts/')) return new Response(JSON.stringify({ code: 200, rows: [PACKAGE] }), { status: 200 })
    return new Response('{}', { status: 200 })
  }
  return { fetchImpl, calls }
}

test('the registry, the station map and the metered list agree on the Zhipu route', () => {
  const vendor = VENDORS.find((entry) => entry.id === 'zhipu')
  assert.notEqual(vendor, undefined, 'the registry carries a Zhipu vendor')
  assert.deepEqual([...vendor.providers], ['zai-coding-cn'])
  assert.equal(vendor.priceTableId, undefined, 'a coding plan publishes no token price')
  assert.ok(METERED_PROVIDERS.includes('zai-coding-cn'), 'its facts are recorded')
  assert.notEqual(hostForProvider('zai-coding-cn'), undefined, 'and it has an official station')
})

test('concurrent readers share one Zhipu round of requests', async () => {
  const ledger = await openedLedger()
  const { fetchImpl, calls } = zhipuFetch()
  const service = new UsageMeterService({
    ledger,
    now: () => 1_000,
    balanceTtlMs: 60_000,
    readZhipuCredential: async () => ({ apiKey: 'k' }),
    fetchImpl,
  })

  const [first, second] = await Promise.all([
    service.refreshZhipuAccount({ force: true }),
    service.refreshZhipuAccount({ force: true }),
  ])
  assert.equal(calls.length, 3, 'one round: quota, cash report and packages')
  assert.equal(first, second, 'the second caller joins the reading in flight')

  // Inside the TTL nothing new is asked for.
  await service.refreshZhipuAccount()
  assert.equal(calls.length, 3)
  await ledger.close()
})

test('a failing refresh keeps the last good reading', async () => {
  const ledger = await openedLedger()
  const good = zhipuFetch()
  const service = new UsageMeterService({
    ledger,
    now: () => 1_000,
    balanceTtlMs: 0,
    readZhipuCredential: async () => ({ apiKey: 'k' }),
    fetchImpl: good.fetchImpl,
  })
  await service.refreshZhipuAccount({ force: true })
  assert.equal(service.zhipuView().packages.length, 1)

  const bad = zhipuFetch({ failing: true })
  service.fetchImpl = bad.fetchImpl
  const stale = await service.refreshZhipuAccount({ force: true })
  assert.equal(stale.status, 'stale')
  assert.equal(service.zhipuView().packages.length, 1, 'the number nobody can re-read stays on screen')
  assert.match(service.zhipuView().message, /503|HTTP/)
  await ledger.close()
})

test('the privacy switch hides the cash amount and keeps the token packages', async () => {
  const ledger = await openedLedger()
  const { fetchImpl } = zhipuFetch()
  const service = new UsageMeterService({
    ledger,
    config: { hideBalance: true },
    now: () => 1_000,
    balanceTtlMs: 60_000,
    readZhipuCredential: async () => ({ apiKey: 'k' }),
    fetchImpl,
  })
  await service.refreshZhipuAccount({ force: true })

  const slice = service.zhipuView()
  assert.equal(slice.balance, undefined, 'money is not shown')
  assert.equal(slice.packages.length, 1, 'a token count is not private data')
  assert.equal(slice.plan.applicable, false, 'and the account is honestly reported as plan-less')
  await ledger.close()
})

test('only a read about the Zhipu route asks the Zhipu station', async () => {
  const ledger = await openedLedger()
  const { fetchImpl, calls } = zhipuFetch()
  const service = new UsageMeterService({
    ledger,
    now: () => 1_000,
    balanceTtlMs: 0,
    readZhipuCredential: async () => ({ apiKey: 'k' }),
    fetchImpl,
  })

  service.view({ sessionId: 's1' })
  await new Promise((resolve) => { setTimeout(resolve, 0) })
  assert.equal(calls.length, 0, 'a read with no route hint pays for nothing')

  service.view({ sessionId: 's1', provider: 'deepseek-official' })
  await new Promise((resolve) => { setTimeout(resolve, 0) })
  assert.equal(calls.length, 0, 'nor does a read about another vendor')

  service.view({ sessionId: 's1', provider: 'zai-coding-cn' })
  await new Promise((resolve) => { setTimeout(resolve, 5) })
  assert.equal(calls.length, 3, 'a Zhipu read warms its own account')
  assert.equal(service.view({ sessionId: 's1' }).zhipu.packages.length, 1)
  await ledger.close()
})

test('a GLM call is metered for tokens and no price is invented for it', async () => {
  const ledger = await openedLedger()
  const service = new UsageMeterService({ ledger, now: () => 1_000 })

  const stored = service.recordUsage({
    callId: 'glm-1',
    provider: 'zai-coding-cn',
    model: 'glm-5.3',
    sessionId: 's1',
    startedAt: 1_000,
    completedAt: 1_010,
    usage: { inputTokens: 100, cacheReadTokens: 900, outputTokens: 20, cacheWriteTokens: 0 },
  })
  assert.equal(stored.ok, true)
  assert.equal(stored.quote.status, 'unpriced', 'the DeepSeek table never prices another vendor')

  const session = service.view({ sessionId: 's1' }).usage.session
  assert.equal(session.calls, 1)
  assert.equal(session.usage.inputTokens, 100)
  assert.equal(session.usage.cacheReadTokens, 900)
  assert.equal(session.usage.promptTokens, 1_000)
  assert.equal(session.amountMicros, undefined, 'an estimated price would be a number nobody billed')
  await ledger.close()
})
