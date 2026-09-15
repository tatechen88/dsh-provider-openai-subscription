/**
 * Zhipu / GLM account readings.
 *
 * The fixtures are the shapes the China station actually returned in this
 * deployment: the account has no Coding Plan (so the monitor endpoint answers a
 * business refusal), and its remaining quota is held as resource packages. The
 * plan-window fixture is the documented `limits[]` shape rather than a sample,
 * because this account has no plan to sample; it is marked as such below.
 *
 * @module dsh-provider-openai-subscription/test/usage-zhipu-account
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  ZHIPU_HOSTS,
  ZhipuAccountError,
  authorizationFor,
  fetchZhipuAccount,
  hostForProvider,
  parseAccountReport,
  parseQuota,
  parseTokenAccounts,
} from '../src/usage/zhipu-account.js'

/** The real refusal an account without a Coding Plan receives (HTTP 200). */
const NO_PLAN = { code: 500, msg: '当前用户不存在coding plan', success: false }

/** The real cash-account report shape. */
const ACCOUNT_REPORT = {
  code: 200,
  msg: '操作成功',
  data: {
    balance: 0,
    rechargeAmount: 0,
    giveAmount: 0,
    totalSpendAmount: 0,
    availableBalance: 0,
    frozenBalance: 0,
    creditStatus: 'NOT_OPEN',
    isKA: false,
    todaySpendAmount: null,
  },
  success: true,
}

/** One real resource-package row, trimmed to the fields this plugin reads. */
function packageRow(overrides = {}) {
  return {
    tokenBalance: 2_000_000,
    tokensMagnitude: 2_000_000,
    resourcePackageName: '【新用户专享】200万通用模型推理资源包',
    consumeType: 'TOKENS',
    status: 'EFFECTIVE',
    expirationTime: '2026-11-27T02:53:54',
    suitableModel: '适用于通用大模型、超拟人大模型、向量模型使用',
    ...overrides,
  }
}

test('each route maps to its own station, and no route maps anywhere else', () => {
  assert.equal(hostForProvider('zai-coding-cn'), ZHIPU_HOSTS['zai-coding-cn'])
  assert.equal(hostForProvider('zai'), 'https://api.z.ai')
  assert.equal(hostForProvider('deepseek-official'), undefined, 'another vendor never resolves here')
  assert.equal(hostForProvider(undefined), undefined)
  assert.equal(hostForProvider('__proto__'), undefined, 'a prototype key is not a route')
})

test('the China monitor endpoint takes the raw key while every other call takes Bearer', () => {
  assert.equal(authorizationFor('https://open.bigmodel.cn', 'k'), 'k')
  assert.equal(authorizationFor('https://api.z.ai', 'k'), 'Bearer k')
})

test('an account without a Coding Plan is not applicable, never a zero percent', () => {
  const quota = parseQuota(NO_PLAN)
  assert.equal(quota.applicable, false)
  assert.deepEqual(quota.windows, [])
  assert.match(quota.reason, /coding plan/i, 'the refusal explains itself instead of drawing 0%')
})

test('plan windows map to remaining percent and reset time', () => {
  // Documented `limits[]` shape (this account has no plan to sample).
  const quota = parseQuota({
    code: 200,
    success: true,
    data: {
      limits: [
        { type: 'TOKENS_LIMIT', unit: 3, percentage: 42, nextResetTime: 1_760_000_000_000 },
        { type: 'TOKENS_LIMIT', unit: 6, percentage: 17, nextResetTime: 1_760_600_000_000 },
        { type: 'TIME_LIMIT', currentValue: 3, usage: 100, nextResetTime: 1_762_000_000_000 },
      ],
    },
  })
  assert.equal(quota.applicable, true)
  assert.equal(quota.windows.length, 3)
  assert.equal(quota.windows[0].remainingPercent, 58)
  assert.equal(quota.windows[0].resetsAt, 1_760_000_000_000)
  assert.equal(quota.windows[2].remainingPercent, 97, 'a used/limit pair becomes a percentage too')
  assert.equal(quota.windows[2].limit, 100)
})

test('an applicable plan that reports no windows says so instead of claiming zero', () => {
  const quota = parseQuota({ code: 200, success: true, data: { limits: [] } })
  assert.equal(quota.applicable, true)
  assert.deepEqual(quota.windows, [])
  assert.match(quota.reason, /no usage windows/)
})

test('the cash report keeps a real zero and rejects an unreported one', () => {
  const balance = parseAccountReport(ACCOUNT_REPORT)
  assert.equal(balance.currency, 'CNY')
  assert.equal(balance.available, 0, 'a reported zero balance is data')
  assert.equal(balance.spent, 0)
  assert.equal(balance.creditStatus, 'NOT_OPEN')

  const blank = parseAccountReport({ code: 200, success: true, data: { availableBalance: '', balance: '' } })
  assert.equal(blank, undefined, 'an empty string is "not reported", not zero')
})

test('resource packages keep tokens and per-use packages apart', () => {
  const packages = parseTokenAccounts({
    code: 200,
    rows: [
      packageRow(),
      packageRow({ resourcePackageName: '【新用户专享】600万GLM-4.6V资源包', tokenBalance: 6_000_000, tokensMagnitude: 6_000_000, suitableModel: 'glm-4.6v' }),
      packageRow({ resourcePackageName: '【新用户专享】20次图片/视频生成资源包', tokenBalance: 20, consumeType: 'TIMES', suitableModel: '适用于通用大模型' }),
      packageRow({ resourcePackageName: 'expired', status: 'EXPIRED' }),
    ],
  })
  assert.equal(packages.length, 3, 'a non-effective package is not remaining quota')
  assert.equal(packages[0].kind, 'tokens')
  assert.equal(packages[0].remaining, 2_000_000)
  assert.equal(packages[2].kind, 'times', 'a per-use package is not counted as tokens')
  assert.equal(packages[1].scope, 'glm-4.6v')
})

test('a reading keeps what succeeded and reports what failed', async () => {
  const calls = []
  const snapshot = await fetchZhipuAccount({
    providerId: 'zai-coding-cn',
    apiKey: 'secret-key',
    now: () => 1_000,
    fetchImpl: async (url, init) => {
      calls.push({ url, auth: init.headers.authorization })
      const path = new URL(url).pathname
      if (path.endsWith('/quota/limit')) return new Response(JSON.stringify(NO_PLAN), { status: 200 })
      if (path.endsWith('/query-customer-account-report')) return new Response(JSON.stringify(ACCOUNT_REPORT), { status: 200 })
      if (path.includes('/tokenAccounts/')) {
        return new Response(JSON.stringify({ code: 200, rows: [packageRow()] }), { status: 200 })
      }
      return new Response('{}', { status: 200 })
    },
  })

  assert.equal(snapshot.status, 'ok', 'an account with packages but no plan is a healthy reading')
  assert.equal(snapshot.plan.applicable, false)
  assert.equal(snapshot.balance.available, 0)
  assert.equal(snapshot.packages.length, 1)
  assert.deepEqual(snapshot.errors, [])
  assert.equal(snapshot.fetchedAt, 1_000)
  assert.ok(calls.length >= 3)
  for (const call of calls) {
    assert.equal(new URL(call.url).origin, ZHIPU_HOSTS['zai-coding-cn'], 'the key only ever reaches the allowlisted station')
    assert.equal(call.auth, 'secret-key', 'the China station takes the raw key')
  }
})

test('the international route sends the same readings with a Bearer header', async () => {
  const seen = []
  await fetchZhipuAccount({
    providerId: 'zai',
    apiKey: 'secret-key',
    fetchImpl: async (url, init) => {
      seen.push({ origin: new URL(url).origin, auth: init.headers.authorization })
      return new Response(JSON.stringify(NO_PLAN), { status: 200 })
    },
  })
  assert.ok(seen.every((call) => call.origin === 'https://api.z.ai'))
  assert.ok(seen.every((call) => call.auth === 'Bearer secret-key'))
})

test('an account with nothing to read reports no-data rather than an empty success', async () => {
  const snapshot = await fetchZhipuAccount({
    providerId: 'zai-coding-cn',
    apiKey: 'secret-key',
    fetchImpl: async (url) => {
      const path = new URL(url).pathname
      if (path.includes('/tokenAccounts/')) return new Response(JSON.stringify({ code: 200, rows: [] }), { status: 200 })
      return new Response(JSON.stringify(NO_PLAN), { status: 200 })
    },
  })
  assert.equal(snapshot.status, 'no-data')
  assert.equal(snapshot.balance, undefined)
  assert.deepEqual(snapshot.packages, [])
})

test('a station failure is reported as its own status', async () => {
  const snapshot = await fetchZhipuAccount({
    providerId: 'zai-coding-cn',
    apiKey: 'secret-key',
    fetchImpl: async () => new Response('nope', { status: 503 }),
  })
  assert.equal(snapshot.status, 'http')
  assert.ok(snapshot.errors.includes('http'))
})

test('a stalled response is cut off by the bound, body included', async () => {
  const snapshot = await fetchZhipuAccount({
    providerId: 'zai-coding-cn',
    apiKey: 'secret-key',
    timeoutMs: 20,
    fetchImpl: async (_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => {
        reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
      }, { once: true })
    }),
  })
  assert.equal(snapshot.status, 'timeout')
})

test('an unknown route or a missing key is refused before any request', async () => {
  let called = false
  const calls = { fetchImpl: async () => { called = true; return new Response('{}', { status: 200 }) } }
  await assert.rejects(
    () => fetchZhipuAccount({ providerId: 'zai-coding', apiKey: 'k', ...calls }),
    (error) => error instanceof ZhipuAccountError && error.code === 'unsupported-provider',
  )
  await assert.rejects(
    () => fetchZhipuAccount({ providerId: 'zai-coding-cn', apiKey: undefined, ...calls }),
    (error) => error instanceof ZhipuAccountError && error.code === 'unconfigured',
  )
  assert.equal(called, false, 'no request is made for a route or key it cannot serve')
})
