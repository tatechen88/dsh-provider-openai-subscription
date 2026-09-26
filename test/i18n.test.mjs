import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { dictionaryFor, dictionaryGaps, resolveLanguage, translatorFor } from '../src/i18n.js'
import { writeRuntimeRecord } from '../src/runtime-record.js'
import { runtimeRecordPath } from '../src/state.js'

/**
 * The words this plugin says exist in exactly two languages, and every consumer
 * of them resolves one at activation. What must not drift: the dictionaries
 * agreeing on their keys, the fallback order, and the record writes landing in
 * the order they were asked for.
 */

test('both dictionaries carry exactly the same keys', () => {
  assert.deepEqual(dictionaryGaps(), [], 'a key on one side only is a sentence the other language cannot say')
})

test('locale ids map onto a dictionary, unknowns onto English', () => {
  assert.equal(dictionaryFor('zh-CN'), 'zh')
  assert.equal(dictionaryFor('zh-TW'), 'zh')
  assert.equal(dictionaryFor('zh'), 'zh')
  assert.equal(dictionaryFor('en-US'), 'en')
  assert.equal(dictionaryFor('ja-JP'), 'en')
  assert.equal(dictionaryFor(undefined), 'en')
})

test('the harness preference wins, the process locale answers for it', async () => {
  const settings = { describe: async () => [{ ns: 'locale', value: { preference: 'zh-CN' } }] }
  assert.equal(await resolveLanguage({ settings, processLocale: () => 'en-US' }), 'zh')

  const unreadable = { describe: async () => { throw new Error('not mounted') } }
  assert.equal(await resolveLanguage({ settings: unreadable, processLocale: () => 'zh-CN' }), 'zh')
  assert.equal(await resolveLanguage({ settings: undefined, processLocale: () => 'en-US' }), 'en')

  // A preference row that names nothing falls through like an absent one.
  const empty = { describe: async () => [{ ns: 'locale', value: {} }] }
  assert.equal(await resolveLanguage({ settings: empty, processLocale: () => 'zh-CN' }), 'zh')
})

test('interpolation fills the named holes and leaves the unnamed ones visible', () => {
  const t = translatorFor('en')
  assert.equal(t('adapter.error.unauthorized', { status: '401' }), 'OpenAI subscription credential was rejected; sign in again (HTTP 401)')
  assert.equal(t('adapter.error.unauthorized'), 'OpenAI subscription credential was rejected; sign in again (HTTP {status})')
  const zh = translatorFor('zh')
  assert.equal(zh('adapter.error.unauthorized', { status: '401' }), 'OpenAI 订阅凭据被拒绝；请重新登录（HTTP 401）')
})

test('a usage limit reads as a window in both languages', async () => {
  const { OpenAISubscriptionAdapter } = await import('../src/provider/adapter.js')
  const body = JSON.stringify({
    error: {
      type: 'usage_limit_reached',
      plan_type: 'plus',
      resets_at: 1790434784,
      limit_window_minutes: 300,
      resets_in_seconds: 243,
    },
  })
  for (const [language, patterns] of [
    ['en', [/5-hour usage limit reached/, /plan: plus/, /resets in about 4 minute/]],
    ['zh', [/5小时额度已用尽/, /套餐: plus/, /约 4 分钟后重置/]],
  ]) {
    const adapter = new OpenAISubscriptionAdapter({
      getAccess: async () => ({ accessToken: 'at', accountId: 'acct_1' }),
      fetchImpl: async () => new Response(body, { status: 429 }),
      t: translatorFor(language),
    })
    await assert.rejects(
      async () => {
        for await (const chunk of adapter.stream({ model: 'gpt-6-sol', messages: [] })) void chunk
      },
      (error) => {
        assert.equal(error.code, 'usage-limit-reached')
        for (const pattern of patterns) assert.match(error.message, pattern)
        assert.equal(error.message.includes('| request:'), false)
        return true
      },
    )
  }
})

test('a zh deployment words its tools in Chinese', async () => {
  const { toolOptions } = await import('../src/tools.js')
  const options = toolOptions({
    operations: { status: async () => ({}), login: async () => ({}), logout: async () => ({}), quota: async () => ({}), usage: async () => ({}) },
    t: translatorFor('zh'),
  })
  const status = options.find((entry) => entry.name === 'openai_subscription_status')
  assert.match(status.description, /登录状态/)
  assert.equal(status.presentCall().title, 'OpenAI 订阅状态')
  // English remains the default when no translator is handed in, so tests and
  // headless callers stay deterministic.
  const english = toolOptions({
    operations: { status: async () => ({}), login: async () => ({}), logout: async () => ({}), quota: async () => ({}), usage: async () => ({}) },
  })
  assert.match(english.find((entry) => entry.name === 'openai_subscription_status').description, /sign-in state/)
})

test('record writes land in call order, whole, last write last', async () => {
  const home = await mkdtemp(join(tmpdir(), 'record-order-'))
  try {
    // Two overlapping writes, the second fired without awaiting the first —
    // exactly what teardown does. Before the queue, they shared one temp file
    // and the loser's rename could land out of order.
    const first = writeRuntimeRecord({ step: 1, startedAt: 1 }, home)
    const second = writeRuntimeRecord({ step: 2, startedAt: 2, stoppedAt: 3 }, home)
    assert.equal(await first, true)
    assert.equal(await second, true)
    const final = JSON.parse(await readFile(runtimeRecordPath(home), 'utf8'))
    assert.equal(final.step, 2, 'the last write must be the last to land')
    assert.equal(final.stoppedAt, 3)

    // A write that cannot land reports false and does not poison the queue.
    const broken = await mkdtemp(join(tmpdir(), 'record-order-broken-'))
    try {
      await writeFile(join(broken, 'plugin-state'), 'not a directory', 'utf8')
      assert.equal(await writeRuntimeRecord({ step: 3 }, broken), false)
    } finally {
      await rm(broken, { recursive: true, force: true })
    }
    assert.equal(await writeRuntimeRecord({ step: 4 }, home), true)
    assert.equal(JSON.parse(await readFile(runtimeRecordPath(home), 'utf8')).step, 4)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})
