/**
 * The DeepSeek price page, read as data.
 *
 * The built-in snapshot in `pricing.js` is a table somebody typed in on the day
 * they read the page. Models ship between those days, and a model the table does
 * not know is priced at nothing. This module reads the same page the snapshot was
 * read from, so a shipped model can be priced without a release here.
 *
 * Two rules keep that safe:
 *
 * - the page is the only source; nothing here invents a rate, and a table that
 *   does not parse completely is rejected as a whole rather than partly adopted;
 * - the retired model names are carried over only while the page still names
 *   them, so a name the vendor has dropped stops being priced by this meter too.
 *
 * @module dsh-provider-openai-subscription/usage/deepseek-pricing-page
 */

import { MICROS_PER_UNIT, PEAK_WINDOWS } from './pricing.js'

/** Host allowed to serve the price page. */
export const DEEPSEEK_PRICING_HOST = 'api-docs.deepseek.com'

/** Path of the price page this meter reads. */
export const DEEPSEEK_PRICING_PATH = '/zh-cn/quick_start/pricing/'

/** Default request timeout. */
export const DEEPSEEK_PRICING_TIMEOUT_MS = 15_000

/** Stable error carrying a UI-facing classification. */
export class DeepSeekPricingError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   */
  constructor(code, message) {
    super(message)
    this.name = 'DeepSeekPricingError'
    this.code = code
  }
}

/** The one URL this module reads. There is no configurable base: the page is public. */
export function resolvePricingPageUrl() {
  return `https://${DEEPSEEK_PRICING_HOST}${DEEPSEEK_PRICING_PATH}`
}

/**
 * Fetch the price page.
 * @param {object} [options]
 * @param {(url: string, init: object) => Promise<Response>} [options.fetchImpl]
 * @param {number} [options.timeoutMs]
 * @returns {Promise<string>} the page HTML.
 */
export async function fetchPricingPage({ fetchImpl = globalThis.fetch, timeoutMs = DEEPSEEK_PRICING_TIMEOUT_MS } = {}) {
  const url = resolvePricingPageUrl()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  timer.unref?.()
  try {
    let response
    try {
      response = await fetchImpl(url, {
        method: 'GET',
        headers: { accept: 'text/html' },
        signal: controller.signal,
        // The page is read from one exact URL: a redirect could land somewhere
        // this module never agreed to read a price from.
        redirect: 'error',
      })
    } catch (error) {
      const aborted = error !== null && typeof error === 'object' && error.name === 'AbortError'
      throw new DeepSeekPricingError(
        aborted ? 'timeout' : 'network',
        `DeepSeek price page request failed: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
    if (!response.ok) {
      throw new DeepSeekPricingError('http', `DeepSeek price page returned HTTP ${response.status}`)
    }
    // The timeout has to cover the body: headers followed by a stall would
    // otherwise hold the refresh open until the runtime's own default expires.
    return await response.text().catch((error) => {
      if (error !== null && typeof error === 'object' && error.name === 'AbortError') {
        throw new DeepSeekPricingError('timeout', `DeepSeek price page body timed out after ${timeoutMs}ms`)
      }
      throw new DeepSeekPricingError('body', `DeepSeek price page body could not be read: ${error instanceof Error ? error.message : String(error)}`)
    })
  } finally {
    clearTimeout(timer)
  }
}

/** Strip tags, decode the entities the page uses, and collapse whitespace. */
function textOf(html) {
  return html
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim()
}

/** One cell's text plus the span it covers. */
function cellsOf(rowHtml) {
  const cells = []
  for (const match of rowHtml.matchAll(/<t[dh]([^>]*)>([\s\S]*?)<\/t[dh]>/gi)) {
    const attributes = match[1]
    const colspan = Number(/\bcolspan\s*=\s*"?(\d+)/i.exec(attributes)?.[1] ?? 1)
    const rowspan = Number(/\browspan\s*=\s*"?(\d+)/i.exec(attributes)?.[1] ?? 1)
    cells.push({
      text: textOf(match[2]),
      colspan: Number.isSafeInteger(colspan) && colspan > 0 ? colspan : 1,
      rowspan: Number.isSafeInteger(rowspan) && rowspan > 0 ? rowspan : 1,
    })
  }
  return cells
}

/**
 * Lay the rows out on a grid, so `rowspan`/`colspan` stop hiding which model a
 * value belongs to. A cell appears once at its origin and again as a continuation
 * for every position it covers.
 * @param {object[][]} rows
 * @returns {Array<Array<{text: string, origin: boolean}|undefined>>}
 */
function toGrid(rows) {
  const grid = []
  rows.forEach((cells, rowIndex) => {
    if (grid[rowIndex] === undefined) grid[rowIndex] = []
    let column = 0
    for (const cell of cells) {
      while (grid[rowIndex][column] !== undefined) column += 1
      for (let dr = 0; dr < cell.rowspan; dr += 1) {
        for (let dc = 0; dc < cell.colspan; dc += 1) {
          if (grid[rowIndex + dr] === undefined) grid[rowIndex + dr] = []
          grid[rowIndex + dr][column + dc] = { text: cell.text, origin: dr === 0 && dc === 0 }
        }
      }
      column += cell.colspan
    }
  })
  return grid
}

/** Which rate a price row states. */
function rateKindOf(text) {
  if (text.includes('缓存未命中')) return 'cacheMiss'
  if (text.includes('缓存命中')) return 'cacheHit'
  if (text.includes('输出')) return 'output'
  return undefined
}

/** Which band a price row states. */
function bandOf(text) {
  if (text.includes('空闲时段')) return 'offPeak'
  if (text.includes('高峰时段')) return 'peak'
  return undefined
}

/**
 * Read `4.5元` as integer micro units, without floating point.
 *
 * A rate that is not exactly a decimal amount of the page's currency is
 * unreadable rather than approximately right: an approximated price would be a
 * number nobody billed.
 * @param {string} text
 * @returns {number|undefined}
 */
export function yuanToMicros(text) {
  const match = /^([0-9]+)(?:\.([0-9]+))?元$/.exec(text.replace(/\s+/g, ''))
  if (match === null) return undefined
  const fraction = match[2] ?? ''
  if (fraction.length > 6) return undefined
  const micros = Number(match[1]) * MICROS_PER_UNIT + Number(fraction.padEnd(6, '0'))
  return Number.isSafeInteger(micros) ? micros : undefined
}

/** The page's own peak-window sentence, in hours and minutes. */
function windowsOf(html) {
  const match = /高峰时段为北京时间周一至周五\s*([0-9]{1,2}):([0-9]{2})\s*-\s*([0-9]{1,2}):([0-9]{2})\s*[、,]\s*([0-9]{1,2}):([0-9]{2})\s*-\s*([0-9]{1,2}):([0-9]{2})/.exec(textOf(html))
  if (match === null) return undefined
  const minutes = (hour, minute) => Number(hour) * 60 + Number(minute)
  const ranges = [
    [minutes(match[1], match[2]), minutes(match[3], match[4])],
    [minutes(match[5], match[6]), minutes(match[7], match[8])],
  ]
  if (ranges.some(([start, end]) => !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= end)) return undefined
  return { ...PEAK_WINDOWS, ranges }
}

/** The Beijing calendar date of one instant, which is the vendor's own day. */
function beijingDate(ms) {
  return new Date(ms + 8 * 60 * 60 * 1000).toISOString().slice(0, 10)
}

/**
 * Parse the official price page into one schedule.
 *
 * Every model column must state all three rates in both bands. A page that says
 * anything else is rejected whole: adopting half a table would price some calls
 * from the new numbers and others from the old ones, with no way to tell which.
 * @param {string} html
 * @param {object} [options]
 * @param {() => number} [options.now]
 * @param {Record<string, string>} [options.previousAliases] - retired names the
 *   table in force carries. One is kept only while this page still names it and
 *   the model it points at is still on the page.
 * @returns {{ok: true, schedule: object}|{ok: false, reason: string}}
 */
export function parsePricingPage(html, { now = Date.now, previousAliases = {} } = {}) {
  if (typeof html !== 'string' || html.length === 0) return { ok: false, reason: 'empty-page' }
  const table = /<table[\s\S]*?<\/table>/i.exec(html)
  if (table === null) return { ok: false, reason: 'no-table' }

  const rows = [...table[0].matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)].map((match) => cellsOf(match[1]))
  if (rows.length < 2) return { ok: false, reason: 'no-rows' }
  const grid = toGrid(rows)
  const header = grid[0] ?? []

  // Model columns are the header cells that name a model slug. The label cell
  // ("模型") spans the columns to their left and is skipped by its own text.
  const models = {}
  const columns = new Map()
  header.forEach((cell, column) => {
    if (cell === undefined || cell.origin !== true) return
    const slug = cell.text.trim().replace(/\([0-9]+\)$/, '').trim()
    if (!/^[a-z0-9][a-z0-9._-]*$/i.test(slug)) return
    models[slug] = { offPeak: {}, peak: {} }
    columns.set(column, slug)
  })
  if (columns.size === 0) return { ok: false, reason: 'no-models' }

  for (const row of grid) {
    if (row === undefined) continue
    const band = bandOf((row.find((cell) => cell !== undefined && bandOf(cell.text) !== undefined) ?? { text: '' }).text)
    if (band === undefined) continue
    // The rate kind sits in a cell that spans both band rows, so the nearest cell
    // to its left that names one is the kind of this row.
    let kind
    for (let column = 0; column < row.length; column += 1) {
      const cell = row[column]
      if (cell === undefined) continue
      const candidate = rateKindOf(cell.text)
      if (candidate !== undefined) kind = candidate
    }
    if (kind === undefined) continue
    for (const [column, slug] of columns) {
      const value = row[column]
      const micros = value === undefined ? undefined : yuanToMicros(value.text)
      if (micros === undefined) return { ok: false, reason: `unreadable-rate:${slug}.${kind}.${band}` }
      models[slug][band][kind] = micros
    }
  }

  for (const [slug, bands] of Object.entries(models)) {
    for (const band of ['offPeak', 'peak']) {
      for (const kind of ['cacheHit', 'cacheMiss', 'output']) {
        if (!Number.isSafeInteger(bands[band][kind])) return { ok: false, reason: `missing-rate:${slug}.${kind}.${band}` }
      }
    }
    // Both bands always exist on the page; if the off-peak number is the larger
    // one for every rate, the value columns were read the wrong way round.
    if (bands.offPeak.cacheMiss > bands.peak.cacheMiss && bands.offPeak.output > bands.peak.output) {
      return { ok: false, reason: `bands-look-swapped:${slug}` }
    }
  }

  const pageText = textOf(html)
  const aliases = {}
  for (const [alias, target] of Object.entries(previousAliases)) {
    if (typeof alias !== 'string' || typeof target !== 'string') continue
    if (!pageText.includes(alias)) continue
    if (models[target] === undefined) continue
    aliases[alias] = target
  }

  const windows = windowsOf(html)
  const retrievedAt = beijingDate(now())
  return {
    ok: true,
    schedule: {
      id: `deepseek-public-${retrievedAt}`,
      provider: 'deepseek-official',
      status: 'official-current',
      currency: 'CNY',
      sourceUrl: resolvePricingPageUrl(),
      retrievedAt,
      source: 'official-price-page',
      windows: windows ?? PEAK_WINDOWS,
      // Which part of the schedule the page stated itself, so a reader knows how
      // much of it came from the page.
      windowSource: windows === undefined ? 'builtin' : 'page',
      models,
      aliases,
    },
  }
}
