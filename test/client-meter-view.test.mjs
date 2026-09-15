/**
 * Unified indicator view contracts.
 *
 * The indicator is the one surface that follows the model switch, so its pure
 * view functions are tested directly: given the same provider and payloads they
 * must always produce the same line, and an unmetered provider must produce
 * nothing at all.
 *
 * @module dsh-provider-openai-subscription/test/client-meter-view
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const clientFile = join(dirname(fileURLToPath(import.meta.url)), '..', 'client', 'client.js')

let captured = null
globalThis.window = { __ModuleLoader__: { load: (registration) => { captured = registration } } }

await import(`${pathToFileURL(clientFile).href}`)

const descriptor = captured.factory((specifier) => {
  if (specifier === 'react') {
    return { createElement: () => null, useEffect: () => {}, useState: (v) => [v, () => {}], useCallback: (fn) => fn, useRef: (v) => ({ current: v }) }
  }
  if (specifier === '@deepseek-ai/dsh-client-ui-primitives') return { Modal: () => null, Button: () => null }
  throw new Error(`unexpected module require: ${specifier}`)
})

const { formatAmount, formatTokens, indicatorHeadline, indicatorTooltip } = descriptor.pure
/** Translator over the bundle's own zh dictionary. */
const t = (key) => descriptor.pure.translate('zh', key)

/** A DeepSeek meter payload with a funded account and today's spend. */
function deepseekMeter(overrides = {}) {
  return {
    account: { kind: 'unknown', declared: false },
    deepseek: {
      status: 'ok',
      available: true,
      fetchedAt: 1,
      infos: [{ currency: 'CNY', total: 86.2, granted: 6.2, toppedUp: 80 }],
      primary: { currency: 'CNY', total: 86.2, granted: 6.2, toppedUp: 80 },
      message: '',
    },
    pricing: {
      public: { scheduleId: 'deepseek-public-2026-09-15', currency: 'CNY', retrievedAt: '2026-09-15', sourceUrl: 'https://example.test/pricing' },
      contractual: { configured: false, active: false },
      estimated: true,
      basis: 'request-start-assumption',
    },
    usage: {
      session: { calls: 2, usage: { promptTokens: 1000, outputTokens: 100, inputTokens: 900, cacheReadTokens: 100, cacheWriteTokens: 0 }, cacheHitRatio: 0.1, amountMicros: 420_000, amountCurrency: 'CNY' },
      today: { calls: 2, usage: { promptTokens: 1000, outputTokens: 100 }, cacheHitRatio: 0.1, amountMicros: 420_000, amountCurrency: 'CNY' },
      month: { calls: 2, usage: { promptTokens: 1000, outputTokens: 100 }, cacheHitRatio: 0.1, amountMicros: 420_000, amountCurrency: 'CNY' },
    },
    ...overrides,
  }
}

test('amounts are printed from integer micro units', () => {
  assert.equal(formatAmount(1_000_000, 'CNY'), '¥1.00')
  assert.equal(formatAmount(420_000, 'CNY'), '¥0.42')
  assert.equal(formatAmount(1_234_567, 'USD'), '$1.23')
  assert.equal(formatAmount(0, 'EUR'), '€0.00')
  assert.equal(formatAmount(500, 'CNY'), '¥0.0005', 'sub-cent spend keeps its precision')
  assert.equal(formatAmount(1000, 'SEK'), 'SEK 0.001')
  assert.equal(formatAmount(undefined, 'CNY'), undefined)
  assert.equal(formatAmount(Number.NaN, 'CNY'), undefined)
})

test('token counts stay readable at every scale', () => {
  assert.equal(formatTokens(0), '0')
  assert.equal(formatTokens(999), '999')
  assert.equal(formatTokens(12_400), '12.4K')
  assert.equal(formatTokens(321_000), '321K')
  assert.equal(formatTokens(2_500_000), '2.5M')
  assert.equal(formatTokens(undefined), '0')
})

test('the headline follows the provider and never mixes the two accounts', () => {
  const quota = { status: 'ready', windows: [{ id: 'primary', remainingPercent: 82 }, { id: 'secondary', remainingPercent: 64 }] }
  const openai = indicatorHeadline({ provider: 'openai-subscription', meter: deepseekMeter(), quota, t })
  assert.equal(openai.text, 'OpenAI 5小时 82% · 每周 64%')
  assert.ok(!openai.text.includes('¥'), 'a subscription session never shows a cash amount')

  const deepseek = indicatorHeadline({ provider: 'deepseek-official', meter: deepseekMeter(), quota, t })
  assert.equal(deepseek.text, 'DeepSeek ¥86.20 · 今日 ¥0.42')
  assert.ok(!deepseek.text.includes('82%'), 'the DeepSeek line never borrows the subscription quota')
})

test('an unmetered or unknown provider renders nothing', () => {
  assert.equal(indicatorHeadline({ provider: 'deepseek', meter: deepseekMeter(), quota: null, t }), null)
  assert.equal(indicatorHeadline({ provider: null, meter: deepseekMeter(), quota: null, t }), null)
  assert.equal(indicatorHeadline({ provider: 'anthropic', meter: null, quota: null, t }), null)
})

test('the seat shows a self-describing placeholder before the first reading', () => {
  // DeepSeek has nothing to say until its first reading arrives, so it renders
  // nothing rather than occupying the seat with a placeholder.
  assert.equal(indicatorHeadline({ provider: 'deepseek-official', meter: null, quota: null, t }), null)
  const waiting = indicatorHeadline({ provider: 'openai-subscription', meter: null, quota: null, t })
  assert.equal(waiting.text, 'OpenAI …', 'the subscription line owns this seat and can say it is waiting')
})

test('a hidden balance leaves the spend, and a hidden spend leaves the balance', () => {
  const hiddenBalance = indicatorHeadline({
    provider: 'deepseek-official',
    meter: deepseekMeter({ deepseek: { status: 'ok', hidden: true, infos: [], message: '' } }),
    quota: null,
    t,
  })
  assert.equal(hiddenBalance.text, 'DeepSeek 今日 ¥0.42')

  const hiddenCost = indicatorHeadline({
    provider: 'deepseek-official',
    meter: deepseekMeter({ usage: { session: { calls: 1, usage: {} }, today: { calls: 1, usage: {} }, month: { calls: 1, usage: {} } } }),
    quota: null,
    t,
  })
  assert.equal(hiddenCost.text, 'DeepSeek ¥86.20')
})

test('a working enterprise agreement is labelled, and an unknown account is not', () => {
  const view = descriptor.pure.translate
  assert.equal(view('zh', 'meterAccountEnterprise'), '企业（用户声明）')
  assert.equal(view('zh', 'meterAccountHint'), '公开 API 不返回实名类型，企业身份始终是用户声明。')
})

test('the tooltip states every period and names the price table in force', () => {
  const meter = deepseekMeter()
  meter.usage.today = { calls: 9, usage: { promptTokens: 900_000, outputTokens: 4_000 }, cacheHitRatio: 0.2, amountMicros: 1_500_000, amountCurrency: 'CNY' }
  meter.usage.month = { calls: 40, usage: { promptTokens: 3_000_000, outputTokens: 20_000 }, cacheHitRatio: 0.3, amountMicros: 7_000_000, amountCurrency: 'CNY' }

  const publicLine = indicatorTooltip({ provider: 'deepseek-official', meter, quota: null, t })
  assert.match(publicLine, /本会话 1\.0K → 100/)
  assert.match(publicLine, /今日 900K → 4\.0K/)
  assert.match(publicLine, /本月 3\.0M → 20\.0K/, 'the month total is stated, not only the session one')
  assert.match(publicLine, /价格来源: 公开价 2026-09-15 估算/)
  assert.doesNotMatch(publicLine, /合同价/, 'no agreement is active, so none is claimed')

  meter.pricing.contractual = { configured: true, active: true, label: 'Acme agreement', currency: 'USD' }
  const contractLine = indicatorTooltip({ provider: 'deepseek-official', meter, quota: null, t })
  assert.match(contractLine, /价格来源: 合同价 Acme agreement 估算/)
  assert.doesNotMatch(contractLine, /公开价/)
})

test('an OpenAI tooltip carries tokens for every period and never a price', () => {
  const meter = deepseekMeter()
  const quota = { windows: [{ id: 'primary', remainingPercent: 82, usedPercent: 18 }, { id: 'secondary', remainingPercent: 64, usedPercent: 36 }] }
  const line = indicatorTooltip({ provider: 'openai-subscription', meter, quota, t })
  assert.match(line, /OpenAI \(ChatGPT OAuth\)/)
  assert.match(line, /5 小时额度 82% \/ 每周额度 64%/)
  assert.match(line, /本会话 1\.0K → 100/)
  assert.doesNotMatch(line, /¥|价格来源/, 'a subscription session has no cash price to name')
})

/**
 * The Zhipu account slice: no coding plan, three effective packages.
 *
 * The station on this deployment refuses a coding plan for the account, so the
 * refusal text is the live one; the packages are the live five reduced to one
 * per consume type.
 */
function zhipuAccount(overrides = {}) {
  return {
    status: 'ok',
    fetchedAt: 1,
    plan: { applicable: false, windows: [], reason: '当前用户不存在coding plan' },
    balance: { currency: 'CNY', available: 0 },
    packages: [
      { name: '通用模型', kind: 'tokens', remaining: 2_000_000, magnitude: 2_000_000, expiresAt: '2026-11-27T00:00:00.000Z' },
      { name: 'glm-4.5-air', kind: 'tokens', remaining: 12_000_000, magnitude: 12_000_000, expiresAt: '2026-11-27T00:00:00.000Z', scope: 'glm-4.5-air' },
      { name: '图片/视频', kind: 'times', remaining: 20, magnitude: 20, expiresAt: '2026-11-27T00:00:00.000Z' },
    ],
    errors: [],
    ...overrides,
  }
}

/** A Zhipu meter payload: that account plus this session's ledger totals. */
function zhipuMeter(overrides = {}) {
  return {
    account: { kind: 'unknown', declared: false },
    zhipu: zhipuAccount(),
    usage: {
      session: { calls: 1, usage: { promptTokens: 1_000_000, outputTokens: 20_000 }, cacheHitRatio: 0.9 },
      today: { calls: 1, usage: { promptTokens: 1_200_000, outputTokens: 30_000 }, cacheHitRatio: 0.9 },
      month: { calls: 1, usage: { promptTokens: 1_200_000, outputTokens: 30_000 }, cacheHitRatio: 0.9 },
    },
    ...overrides,
  }
}

test('a GLM line reads the remaining plan tokens and today use, never a price', () => {
  const line = indicatorHeadline({ provider: 'zai-coding-cn', meter: zhipuMeter(), quota: null, t })
  assert.equal(line.text, 'GLM 余 14M · 今日 1.2M')
  assert.ok(!line.text.includes('¥'), 'a coding plan has no per-call cash settlement')
})

test('a GLM seat stays empty when there is nothing to report', () => {
  const bare = zhipuMeter({ zhipu: zhipuAccount({ packages: [] }), usage: {} })
  assert.equal(indicatorHeadline({ provider: 'zai-coding-cn', meter: bare, quota: null, t }), null)
  assert.equal(indicatorHeadline({ provider: 'zai-coding-cn', meter: null, quota: null, t }), null)
})

test('a GLM card states the plan refusal, the cash, and every package', () => {
  const line = indicatorTooltip({ provider: 'zai-coding-cn', meter: zhipuMeter(), quota: null, t })
  assert.match(line, /GLM \(Z\.AI\)/)
  assert.match(line, /当前用户不存在coding plan/, 'the station own refusal text carries through as data')
  assert.match(line, /余额 ¥0\.00/)
  assert.match(line, /通用模型 2\.0M · 至 2026-11-27/)
  assert.match(line, /glm-4\.5-air 12M · \(glm-4\.5-air\) · 至 2026-11-27/)
  assert.match(line, /图片\/视频 20 次 · 至 2026-11-27/)
  assert.match(line, /本会话 1\.0M → 20\.0K/)
  assert.doesNotMatch(line, /价格来源/, 'no price table prices a coding plan')
})

test('a plan with windows reports them, and an absent cash line stays absent', () => {
  const plan = {
    applicable: true,
    windows: [
      { id: 'TOKENS_LIMIT:3', type: 'TOKENS_LIMIT', unit: 3, remainingPercent: 58 },
      { id: 'TIME_LIMIT:default', type: 'TIME_LIMIT', remainingPercent: 97 },
    ],
  }
  const meter = zhipuMeter({ zhipu: zhipuAccount({ plan, balance: undefined }) })
  const line = indicatorTooltip({ provider: 'zai-coding-cn', meter, quota: null, t })
  assert.match(line, /3h Token 额度 58% \/ 次数额度 97%/)
  assert.doesNotMatch(line, /余额|当前用户不存在/, 'an applicable plan is not reported as a refusal')
})

test('a GLM session line names the route and charges no cash price', () => {
  const { sessionUsageLine } = descriptor.pure
  const line = sessionUsageLine({ provider: 'zai-coding-cn', meter: zhipuMeter(), t })
  assert.equal(line.text, 'GLM · 本会话 1.0M → 20.0K · 缓存命中 90.0%')
  assert.equal(line.detail, 'GLM 用量与费用')
  assert.equal(sessionUsageLine({ provider: 'anthropic', meter: zhipuMeter(), t }), null)
})

test('the meter read carries only the route it serves', () => {
  const { meterUsageUrl } = descriptor.pure
  const base = '/plugins/openai-subscription/meter/usage'
  assert.equal(meterUsageUrl('zai-coding-cn', 's1'), `${base}?sessionId=s1&provider=zai-coding-cn`)
  assert.equal(meterUsageUrl('deepseek-official', null), `${base}?provider=deepseek-official`)
  assert.equal(meterUsageUrl(undefined, 'a b'), `${base}?sessionId=a%20b`)
  assert.equal(meterUsageUrl(null, null), base, 'a read with no route asks no station')
})

test('a route this build never heard of shows its own tokens, never another vendor money', () => {
  const meter = deepseekMeter()
  meter.metered = { auto: true, providers: ['deepseek-official', 'acme-llm'] }
  meter.usage.today = { calls: 3, usage: { promptTokens: 3_400_000, outputTokens: 0 }, cacheHitRatio: 0.5 }

  const line = indicatorHeadline({ provider: 'acme-llm', meter, quota: null, t })
  assert.equal(line.text, 'acme-llm 今日 3.4M')
  assert.ok(!line.text.includes('DeepSeek'), 'a discovered route never borrows the DeepSeek name')
  assert.ok(!line.text.includes('¥'), 'and never claims cash for an account the meter cannot read')

  const card = indicatorTooltip({ provider: 'acme-llm', meter, quota: null, t })
  assert.match(card, /^acme-llm/, 'the card starts with the route it describes')
  assert.match(card, /本会话 1\.0K → 100/, 'and carries the token totals')
  assert.doesNotMatch(card, /DeepSeek|OpenAI|价格来源/, 'with no other vendor balance and no price claim')
})

test('a route the host does not meter renders nothing, whatever the payload says', () => {
  const meter = deepseekMeter()
  meter.metered = { auto: true, providers: ['deepseek-official'] }
  meter.usage.session = { calls: 2, usage: { promptTokens: 12_400, outputTokens: 900 }, cacheHitRatio: 0.64 }
  assert.equal(indicatorHeadline({ provider: 'acme-llm', meter, quota: null, t }), null)
  assert.equal(descriptor.pure.sessionUsageLine({ provider: 'acme-llm', meter, t }), null)

  // A payload without a list comes from a host that does not report one: only the
  // routes this build ships can be vouched for, so an unrelated provider still
  // never borrows the DeepSeek balance.
  delete meter.metered
  assert.equal(indicatorHeadline({ provider: 'acme-llm', meter, quota: null, t }), null)
  assert.equal(indicatorHeadline({ provider: 'deepseek-official', meter, quota: null, t }).text.startsWith('DeepSeek'), true)
})

test('a session line labels a discovered route by its own name', () => {
  const meter = deepseekMeter()
  meter.metered = { auto: true, providers: ['deepseek-official', 'acme-llm'] }
  meter.usage.session = { calls: 2, usage: { promptTokens: 12_400, outputTokens: 900 }, cacheHitRatio: 0.64 }

  const line = descriptor.pure.sessionUsageLine({ provider: 'acme-llm', meter, t })
  assert.equal(line.text, 'acme-llm · 本会话 12.4K → 900 · 缓存命中 64.0%')
  assert.equal(line.detail, 'acme-llm 用量与费用')
  assert.ok(!line.text.includes('¥'), 'no estimate is attached to a route the meter cannot price')
})

test('a card names the models its own price table does not cover', () => {
  const meter = deepseekMeter()
  meter.pricing.unpricedModels = [
    { provider: 'deepseek-official', model: 'deepseek-v5', calls: 3, lastSeenAt: 1 },
    { provider: 'zai-coding-cn', model: 'glm-5.3', calls: 9, lastSeenAt: 1 },
  ]
  const deepseek = indicatorTooltip({ provider: 'deepseek-official', meter, quota: null, t })
  assert.match(deepseek, /未配置价格: deepseek-v5 ×3/, 'a missing rate is named with how often it was used')
  assert.doesNotMatch(deepseek, /glm-5\.3/, 'another vendor missing rate is not this card business')

  const plan = deepseekMeter()
  plan.metered = { auto: true, providers: ['zai-coding-cn'] }
  plan.zhipu = { status: 'ok', fetchedAt: 1, plan: { applicable: true, windows: [] }, packages: [], errors: [] }
  plan.pricing.unpricedModels = [{ provider: 'deepseek-official', model: 'deepseek-v5', calls: 3 }]
  assert.doesNotMatch(
    indicatorTooltip({ provider: 'zai-coding-cn', meter: plan, quota: null, t }),
    /deepseek-v5/,
    'a vendor that publishes no table never lists one',
  )
})

test('a card says when the price table could not be refreshed', () => {
  const meter = deepseekMeter()
  meter.pricing.refresh = { enabled: true, lastAttemptAt: 1, lastError: 'missing-rate:deepseek-flash.output.peak' }
  const line = indicatorTooltip({ provider: 'deepseek-official', meter, quota: null, t })
  assert.match(line, /价格表刷新失败: missing-rate:deepseek-flash\.output\.peak/, 'a page that stopped parsing is visible, not silent')

  const quiet = deepseekMeter()
  quiet.pricing.refresh = { enabled: false, lastAttemptAt: 0 }
  assert.doesNotMatch(
    indicatorTooltip({ provider: 'deepseek-official', meter: quiet, quota: null, t }),
    /价格表刷新失败/,
    'and a switch that is simply off is not an error',
  )
})

test('reasoning tokens are named as part of the output, not on top of it', () => {
  const meter = deepseekMeter()
  meter.usage.today = { calls: 2, usage: { promptTokens: 900_000, outputTokens: 20_000, reasoningTokens: 12_000 }, cacheHitRatio: 0.2 }
  meter.usage.session = { calls: 1, usage: { promptTokens: 1_000, outputTokens: 5 }, cacheHitRatio: 0 }
  const line = indicatorTooltip({ provider: 'deepseek-official', meter, quota: null, t })
  assert.match(line, /今日 900K → 20\.0K（含思考 12\.0K）/, 'the thinking subset explains an output that bills like a big one')
  assert.doesNotMatch(line, /本会话[^·]*含思考/, 'a call with no reasoning reports none')

  const plain = indicatorHeadline({ provider: 'deepseek-official', meter: deepseekMeter(), quota: null, t })
  assert.doesNotMatch(plain.text, /含思考/, 'an account with no reasoning tokens says nothing about them')
})

test('the card breaks a mixed-model session down by model', () => {
  const meter = deepseekMeter()
  // The host already caps this list at the three heaviest; the card renders
  // exactly what it receives.
  meter.usage.session.models = [
    { model: 'glm-5.3', promptTokens: 1_200_000, outputTokens: 30_000, calls: 4 },
    { model: 'deepseek-flash', promptTokens: 200_000, outputTokens: 5_000, calls: 1 },
    { model: 'third', promptTokens: 10, outputTokens: 1, calls: 1 },
  ]
  const line = indicatorTooltip({ provider: 'deepseek-official', meter, quota: null, t })
  assert.match(line, /会话构成: glm-5\.3 1\.2M→30\.0K · deepseek-flash 200K→5\.0K · third 10→1/)
})

test('the card shows which price band is active and when it flips', () => {
  const meter = deepseekMeter()
  meter.pricing.band = { active: 'peak', until: Date.now() + 42 * 60_000 }
  const peak = indicatorTooltip({ provider: 'deepseek-official', meter, quota: null, t })
  assert.match(peak, /高峰时段 · 42 分钟后转空闲时段（半价）/, 'the countdown is the actionable part')

  const cheap = deepseekMeter()
  cheap.pricing.band = { active: 'offPeak', until: Date.now() + 3 * 86_400_000 }
  assert.match(
    indicatorTooltip({ provider: 'deepseek-official', meter: cheap, quota: null, t }),
    /空闲时段（半价） · 3 天 0 小时后转高峰时段/,
  )

  const banded = deepseekMeter()
  banded.pricing.band = { active: 'peak', until: Date.now() + 60_000 }
  assert.doesNotMatch(
    indicatorTooltip({ provider: 'zai-coding-cn', meter: { ...banded, zhipu: { status: 'ok', packages: [] } }, quota: null, t }),
    /高峰时段 ·/,
    'a route without peak windows states none',
  )
})
