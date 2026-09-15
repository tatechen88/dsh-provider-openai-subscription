/**
 * The official DeepSeek price page, read as data.
 *
 * The fixture under `test/fixtures/` is the real page: the pricing table and its
 * footnotes, fetched from `api-docs.deepseek.com` and trimmed. Parsing it has to
 * reproduce exactly the numbers the built-in snapshot carries — that agreement is
 * what makes it safe to prefer a learned table at all.
 *
 * @module dsh-provider-openai-subscription/test/usage-pricing-page
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  DEEPSEEK_PRICING_HOST,
  DeepSeekPricingError,
  fetchPricingPage,
  parsePricingPage,
  resolvePricingPageUrl,
  yuanToMicros,
} from '../src/usage/deepseek-pricing-page.js'
import { DEEPSEEK_PUBLIC_SCHEDULE, PEAK_WINDOWS } from '../src/usage/pricing.js'

const here = dirname(fileURLToPath(import.meta.url))
const page = await readFile(join(here, 'fixtures', 'deepseek-pricing-page.html'), 'utf8')

/** One instant inside the Beijing day the fixture is read on. */
const NOW = Date.UTC(2026, 8, 15, 4, 0)

test('the page parses into exactly the table the built-in snapshot carries', () => {
  const parsed = parsePricingPage(page, { now: () => NOW })
  assert.equal(parsed.ok, true, parsed.ok === true ? '' : parsed.reason)
  const schedule = parsed.schedule
  assert.equal(schedule.provider, 'deepseek-official')
  assert.equal(schedule.currency, 'CNY')
  assert.equal(schedule.status, 'official-current')
  assert.equal(schedule.retrievedAt, '2026-09-15')
  assert.equal(schedule.id, 'deepseek-public-2026-09-15')
  assert.equal(schedule.sourceUrl, resolvePricingPageUrl())
  assert.equal(resolvePricingPageUrl(), `https://${DEEPSEEK_PRICING_HOST}/zh-cn/quick_start/pricing/`)
  assert.deepEqual(schedule.models, DEEPSEEK_PUBLIC_SCHEDULE.models, 'the page and the typed-in snapshot agree rate for rate')
})

test('the page states its own peak windows, and then really uses them', () => {
  const parsed = parsePricingPage(page, { now: () => NOW })
  assert.equal(parsed.schedule.windowSource, 'page', 'the window sentence is on the page, so it is read from there')
  assert.deepEqual(parsed.schedule.windows.ranges, PEAK_WINDOWS.ranges)
  assert.deepEqual(parsed.schedule.windows.weekdays, PEAK_WINDOWS.weekdays)
  assert.equal(parsed.schedule.windows.offsetMinutes, 480)

  const moved = page.replace('9:00 - 12:00、14:00 - 18:00', '10:00 - 11:30、16:00 - 20:00')
  const changed = parsePricingPage(moved, { now: () => NOW })
  assert.deepEqual(changed.schedule.windows.ranges, [[600, 690], [960, 1200]], 'a changed sentence moves the windows')

  const silent = page.replace('高峰时段为北京时间周一至周五 9:00 - 12:00、14:00 - 18:00（其余为空闲时段）。', '高峰时段见公告。')
  const fallback = parsePricingPage(silent, { now: () => NOW })
  assert.equal(fallback.schedule.windowSource, 'builtin')
  assert.deepEqual(fallback.schedule.windows.ranges, PEAK_WINDOWS.ranges, 'a page that stops saying it falls back to the built-in windows')
})

test('retired model names are kept only while the page still names them', () => {
  const parsed = parsePricingPage(page, {
    now: () => NOW,
    previousAliases: {
      'deepseek-v4-flash': 'deepseek-flash',
      'deepseek-v4-flash-vision-exp': 'deepseek-flash',
      // A name the vendor has dropped: the page no longer mentions it, so it
      // stops being priced, and so does one that points at a model that is gone.
      'deepseek-retired-long-ago': 'deepseek-flash',
      'deepseek-v4-flash-2': 'deepseek-v7-unknown',
    },
  })
  assert.deepEqual(parsed.schedule.aliases, {
    'deepseek-v4-flash': 'deepseek-flash',
    'deepseek-v4-flash-vision-exp': 'deepseek-flash',
  })
})

test('a page that does not parse completely is rejected whole', () => {
  // The peak output row is gone: two models would lose one of their six rates.
  const missingRow = page.replace('<tr><td>高峰时段</td><td>8元</td><td>27.0元</td></tr>', '')
  const missing = parsePricingPage(missingRow, { now: () => NOW })
  assert.equal(missing.ok, false)
  assert.match(missing.reason, /^missing-rate:deepseek-flash\.output\.peak$/)

  // A rate in another currency is not a rate this meter can use.
  const otherCurrency = page.replace('0.02元', '¥0.02')
  const unreadable = parsePricingPage(otherCurrency, { now: () => NOW })
  assert.equal(unreadable.ok, false)
  assert.match(unreadable.reason, /^unreadable-rate:deepseek-flash\.cacheHit\.offPeak$/)

  assert.deepEqual(parsePricingPage('', { now: () => NOW }), { ok: false, reason: 'empty-page' })
  assert.deepEqual(parsePricingPage('<html><body>nothing</body></html>', { now: () => NOW }), { ok: false, reason: 'no-table' })
})

test('a table whose bands were read the wrong way round is refused', () => {
  const swapped = page
    .replaceAll('空闲时段', '\u0000')
    .replaceAll('高峰时段', '空闲时段')
    .replaceAll('\u0000', '高峰时段')
  const parsed = parsePricingPage(swapped, { now: () => NOW })
  assert.equal(parsed.ok, false)
  assert.match(parsed.reason, /^bands-look-swapped:/)
})

test('a decimal amount of yuan becomes integer micro units, or nothing', () => {
  assert.equal(yuanToMicros('0.02元'), 20_000)
  assert.equal(yuanToMicros('1元'), 1_000_000)
  assert.equal(yuanToMicros('4.5元'), 4_500_000)
  assert.equal(yuanToMicros('27.0元'), 27_000_000)
  assert.equal(yuanToMicros('0.123456元'), 123_456)
  assert.equal(yuanToMicros('0.1234567元'), undefined, 'finer than a micro unit is not a price this meter can bill')
  assert.equal(yuanToMicros('1.5美元'), undefined, 'another currency is not adopted silently')
  assert.equal(yuanToMicros('免费'), undefined)
  assert.equal(yuanToMicros(''), undefined)
})

test('the price page is fetched from one exact URL and classified when it fails', async () => {
  const seen = []
  const ok = await fetchPricingPage({
    fetchImpl: async (url, init) => {
      seen.push({ url, init })
      return new Response('<table></table>', { status: 200 })
    },
  })
  assert.equal(ok, '<table></table>')
  assert.equal(seen[0].url, resolvePricingPageUrl())
  assert.equal(seen[0].init.method, 'GET')
  assert.equal(seen[0].init.redirect, 'error', 'the page is read from the URL that was agreed, never through a redirect')

  await assert.rejects(
    () => fetchPricingPage({ fetchImpl: async () => new Response('nope', { status: 503 }) }),
    (error) => error instanceof DeepSeekPricingError && error.code === 'http',
  )

  await assert.rejects(
    () => fetchPricingPage({
      fetchImpl: async () => {
        const abort = new Error('aborted')
        abort.name = 'AbortError'
        throw abort
      },
    }),
    (error) => error instanceof DeepSeekPricingError && error.code === 'timeout',
  )
})
