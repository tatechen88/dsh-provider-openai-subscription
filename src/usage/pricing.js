/**
 * Versioned price book for the built-in usage meter.
 *
 * Money is fixed-point, never floating point: a rate is stored as an integer
 * number of micro-currency units per 1,000,000 tokens, and one charge is the
 * exact sum of bucket numerators divided once with commercial rounding.  That
 * keeps cents reproducible across replays and platforms.
 *
 * Prices are estimates.  DeepSeek bills on its own platform; this module never
 * claims to produce an invoice.
 *
 * @module dsh-provider-openai-subscription/usage/pricing
 */

import { readUsageBuckets } from './types.js'

/** Micro units in one currency unit. */
export const MICROS_PER_UNIT = 1_000_000

/** Tokens a rate is quoted per. */
export const RATE_UNIT_TOKENS = 1_000_000

/**
 * DeepSeek peak windows in Asia/Shanghai local time.
 *
 * China has observed no daylight saving since 1991, so the zone is a constant
 * +08:00 and the window test needs no time-zone database.
 */
export const PEAK_WINDOWS = Object.freeze({
  offsetMinutes: 480,
  weekdays: Object.freeze([1, 2, 3, 4, 5]),
  ranges: Object.freeze([Object.freeze([9 * 60, 12 * 60]), Object.freeze([14 * 60, 18 * 60])]),
})

/** DeepSeek official price page used for the built-in snapshot. */
export const DEEPSEEK_PRICING_URL = 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing/'

/** Built-in DeepSeek snapshot date (the day the official page was read). */
export const DEEPSEEK_SNAPSHOT_RETRIEVED_AT = '2026-09-15'

/**
 * DeepSeek official prices, CNY per 1M tokens.
 *
 * Off-peak is half of peak by the official scheme; both bands are stated
 * explicitly so a future change to either one is a data edit, not a formula.
 */
export const DEEPSEEK_PUBLIC_SCHEDULE = Object.freeze({
  id: 'deepseek-public-2026-09-15',
  provider: 'deepseek-official',
  status: 'official-current',
  currency: 'CNY',
  sourceUrl: DEEPSEEK_PRICING_URL,
  retrievedAt: DEEPSEEK_SNAPSHOT_RETRIEVED_AT,
  windows: PEAK_WINDOWS,
  models: Object.freeze({
    'deepseek-flash': Object.freeze({
      offPeak: Object.freeze({ cacheHit: 20_000, cacheMiss: 1_000_000, output: 4_000_000 }),
      peak: Object.freeze({ cacheHit: 40_000, cacheMiss: 2_000_000, output: 8_000_000 }),
    }),
    'deepseek-v4-pro': Object.freeze({
      offPeak: Object.freeze({ cacheHit: 150_000, cacheMiss: 4_500_000, output: 13_500_000 }),
      peak: Object.freeze({ cacheHit: 300_000, cacheMiss: 9_000_000, output: 27_000_000 }),
    }),
  }),
  /**
   * Retired names the vendor still serves.
   *
   * The official price page states that `deepseek-v4-flash` and
   * `deepseek-v4-flash-vision-exp` remain callable, are served by
   * DeepSeek-V4.1-Flash, and are billed at Flash prices. Calling them aliases
   * keeps that sourced relationship in one place instead of duplicating rates
   * that could drift apart.
   */
  aliases: Object.freeze({
    'deepseek-v4-flash': 'deepseek-flash',
    'deepseek-v4-flash-vision-exp': 'deepseek-flash',
  }),
})

/** Public price tables by schedule id, so the vendor registry can name one declaratively. */
export const PUBLIC_SCHEDULES = Object.freeze({
  [DEEPSEEK_PUBLIC_SCHEDULE.id]: DEEPSEEK_PUBLIC_SCHEDULE,
})

/** Charge quoting failed for a reason the caller shows to the user. */
export const UNPRICED_UNKNOWN_MODEL = 'unknown-model'
export const UNPRICED_NO_SCHEDULE = 'no-schedule'
export const UNPRICED_INVALID_USAGE = 'invalid-usage'
/** The selected schedule has no rate for the band this call falls in. */
export const UNPRICED_MISSING_BAND = 'missing-band'

/**
 * Clock parts of one instant under a fixed zone offset.
 * @param {number} atMs - epoch milliseconds.
 * @param {number} offsetMinutes - zone offset east of UTC.
 * @returns {{weekday: number, minutes: number}} weekday 0=Sunday, minutes since local midnight.
 */
export function fixedZoneClock(atMs, offsetMinutes) {
  const shifted = new Date(atMs + offsetMinutes * 60_000)
  return {
    weekday: shifted.getUTCDay(),
    minutes: shifted.getUTCHours() * 60 + shifted.getUTCMinutes(),
  }
}

/**
 * Whether one instant falls in a peak window.
 * @param {number} atMs - epoch milliseconds.
 * @param {{offsetMinutes: number, weekdays: readonly number[], ranges: readonly (readonly number[])[]}} [windows]
 * @returns {boolean}
 */
export function isPeakAt(atMs, windows = PEAK_WINDOWS) {
  const { weekday, minutes } = fixedZoneClock(atMs, windows.offsetMinutes)
  if (!windows.weekdays.includes(weekday)) return false
  return windows.ranges.some(([start, end]) => minutes >= start && minutes < end)
}

/**
 * Which band one instant is in, and when that band ends.
 *
 * The end instant is what makes the bands actionable: off-peak bills at half
 * the peak rate, and the only way to use that is to know when it opens. The
 * active half agrees with {@link isPeakAt} by construction — both read the same
 * clock.
 * @param {number} atMs - epoch milliseconds.
 * @param {{offsetMinutes: number, weekdays: readonly number[], ranges: readonly (readonly number[])[]}} [windows]
 * @returns {{active: 'peak'|'offPeak', until: number}} the band and the instant it switches.
 */
export function bandTransition(atMs, windows = PEAK_WINDOWS) {
  const { weekday, minutes } = fixedZoneClock(atMs, windows.offsetMinutes)
  const toReal = (shiftedMs) => shiftedMs - windows.offsetMinutes * 60_000
  const dayStart = atMs + windows.offsetMinutes * 60_000 - minutes * 60_000
  if (windows.weekdays.includes(weekday)) {
    for (const [start, end] of windows.ranges) {
      if (minutes >= start && minutes < end) {
        return { active: 'peak', until: toReal(dayStart + end * 60_000) }
      }
    }
    const nextStartToday = windows.ranges.find(([start]) => start > minutes)
    if (nextStartToday !== undefined) {
      return { active: 'offPeak', until: toReal(dayStart + nextStartToday[0] * 60_000) }
    }
  }
  // Outside every window: the next band opens on the first peak day that
  // follows, which is at most a week away.
  for (let step = 1; step <= 7; step += 1) {
    if (windows.weekdays.includes((weekday + step) % 7)) {
      return { active: 'offPeak', until: toReal(dayStart + step * 86_400_000 + windows.ranges[0][0] * 60_000) }
    }
  }
  return { active: isPeakAt(atMs, windows) ? 'peak' : 'offPeak', until: atMs + 86_400_000 }
}

/**
 * Look one model up in a schedule's rate table.
 *
 * A match is exact, case-insensitive, or through a vendor-documented alias, so a
 * retired name that is still served is billed at the successor's rate instead of
 * being reported as unpriced.
 * @param {object} schedule
 * @param {string} model
 * @returns {object|undefined}
 */
export function ratesFor(schedule, model) {
  if (schedule === null || typeof schedule !== 'object') return undefined
  const models = schedule.models
  if (models === null || typeof models !== 'object') return undefined
  const direct = lookup(models, model)
  if (direct !== undefined) return direct
  const aliases = schedule.aliases
  if (aliases === null || typeof aliases !== 'object') return undefined
  const target = lookup(aliases, model)
  return typeof target === 'string' ? lookup(models, target) : undefined
}

/**
 * One rate-table lookup: exact key, then a case-insensitive match.
 * @param {object} table
 * @param {string} key
 * @returns {unknown}
 */
function lookup(table, key) {
  if (Object.prototype.hasOwnProperty.call(table, key)) return table[key]
  const normalized = String(key).trim().toLowerCase()
  for (const candidate of Object.keys(table)) {
    if (candidate.toLowerCase() === normalized) return table[candidate]
  }
  return undefined
}

/**
 * The model whose rates actually priced a call, when the schedule names a
 * different successor for a retired request name.
 * @param {object} schedule
 * @param {string} model
 * @returns {string} the requested model, or the successor it is billed as.
 */
export function billedModelOf(schedule, model) {
  const alias = schedule.aliases === undefined || schedule.aliases === null ? undefined : lookup(schedule.aliases, model)
  return typeof alias === 'string' ? alias : model
}

/**
 * Whether a schedule is in force at one instant.
 *
 * A date-only bound names a whole day: an agreement written
 * `validTo: 2026-12-31` still prices calls made on the 31st, and
 * `validFrom: 2026-01-01` starts at that day's first instant. A bound that is
 * present but unparseable counts as absent here; the parser drops such an entry
 * before it can become a schedule.
 *
 * @param {object} schedule
 * @param {number} atMs
 * @returns {boolean}
 */
export function scheduleCovers(schedule, atMs) {
  const from = parseBound(schedule.validFrom, false)
  const to = parseBound(schedule.validTo, true)
  if (from !== undefined && atMs < from) return false
  if (to !== undefined && atMs >= to) return false
  return true
}

/**
 * Parse one validity bound, letting a date-only end bound cover its whole day.
 * @param {unknown} value
 * @param {boolean} endOfDay
 * @returns {number|undefined}
 */
function parseBound(value, endOfDay) {
  if (typeof value !== 'string') return undefined
  const text = value.trim()
  if (text.length === 0) return undefined
  if (endOfDay && /^\d{4}-\d{2}-\d{2}$/.test(text)) {
    const midnight = Date.parse(`${text}T00:00:00Z`)
    return Number.isFinite(midnight) ? midnight + 86_400_000 : undefined
  }
  const ms = Date.parse(text)
  return Number.isFinite(ms) ? ms : undefined
}

/**
 * Order schedules so the most specific applicable one wins: a live contractual
 * agreement beats a dated snapshot, which beats an undated fallback.
 * @param {readonly object[]} schedules
 * @returns {object[]}
 */
function byPrecedence(schedules) {
  const rank = (schedule) => {
    if (schedule.status === 'contractual') return 0
    if (schedule.status === 'official-current') return 1
    return 2
  }
  return [...schedules].sort((left, right) => {
    const delta = rank(left) - rank(right)
    if (delta !== 0) return delta
    return String(right.retrievedAt ?? '').localeCompare(String(left.retrievedAt ?? ''))
  })
}

/**
 * Select the schedule that prices one route at one instant.
 *
 * A contractual schedule is only reachable for a declared enterprise account;
 * declaring an account type never changes a rate by itself.
 * @param {object} request
 * @param {string} request.provider
 * @param {string} request.model
 * @param {number} request.at
 * @param {string} [request.accountKind]
 * @param {readonly object[]} [request.schedules]
 * @returns {object|undefined}
 */
export function resolveSchedule({ provider, model, at, accountKind = 'unknown', schedules = [DEEPSEEK_PUBLIC_SCHEDULE] }) {
  for (const schedule of byPrecedence(schedules)) {
    if (schedule.provider !== provider) continue
    if (schedule.status === 'contractual' && accountKind !== 'enterprise') continue
    if (!scheduleCovers(schedule, at)) continue
    if (ratesFor(schedule, model) === undefined) continue
    return schedule
  }
  return undefined
}

/**
 * Format a rate for display: micro units per million tokens to currency units.
 * @param {number} micros
 * @returns {number}
 */
export function microsToUnits(micros) {
  return micros / MICROS_PER_UNIT
}

/**
 * Exact charge of one usage fact under one schedule.
 *
 * The numerator is summed in BigInt and divided once, so the result carries a
 * single rounding step instead of one per bucket.
 * @param {object} fact - validated UsageFact.
 * @param {object|undefined} schedule
 * @param {object} [options]
 * @param {string} [options.reason] - why no schedule was selected.
 * @returns {object} ChargeQuote.
 */
export function quoteUsage(fact, schedule, options = {}) {
  const buckets = readUsageBuckets(fact.usage)
  if (!buckets.ok) {
    return { status: 'unpriced', reason: UNPRICED_INVALID_USAGE, basis: 'request-start-assumption' }
  }
  if (schedule === undefined || schedule === null) {
    return {
      status: 'unpriced',
      reason: options.reason ?? UNPRICED_NO_SCHEDULE,
      basis: 'request-start-assumption',
    }
  }
  const rates = ratesFor(schedule, fact.model)
  if (rates === undefined) {
    return { status: 'unpriced', reason: UNPRICED_UNKNOWN_MODEL, scheduleId: schedule.id, basis: 'request-start-assumption' }
  }
  const billedModel = billedModelOf(schedule, fact.model)
  const peak = schedule.windows === undefined || schedule.windows === null
    ? false
    : isPeakAt(fact.startedAt, schedule.windows)
  const usePeak = peak && rates.peak !== undefined
  const band = usePeak ? 'peak' : 'offPeak'
  const rate = usePeak ? rates.peak : rates.offPeak
  if (rate === undefined || rate === null) {
    // A schedule with no rate for the band this call falls in cannot price it.
    // Reporting it unpriced is the only safe answer: pricing it as zero would
    // present the call as free.
    return {
      status: 'unpriced',
      reason: UNPRICED_MISSING_BAND,
      scheduleId: schedule.id,
      basis: 'request-start-assumption',
    }
  }
  const miss = BigInt(buckets.buckets.inputTokens) * BigInt(rate.cacheMiss)
  const hit = BigInt(buckets.buckets.cacheReadTokens) * BigInt(rate.cacheHit)
  const out = BigInt(buckets.buckets.outputTokens) * BigInt(rate.output)
  const numerator = miss + hit + out
  const rounded = (numerator + BigInt(RATE_UNIT_TOKENS / 2)) / BigInt(RATE_UNIT_TOKENS)
  return {
    status: 'priced',
    currency: schedule.currency,
    scheduleId: schedule.id,
    scheduleLabel: schedule.label ?? schedule.id,
    band,
    estimated: true,
    basis: 'request-start-assumption',
    billedModel,
    amountMicros: Number(rounded),
    breakdown: {
      cacheMissMicros: Number((miss + BigInt(RATE_UNIT_TOKENS / 2)) / BigInt(RATE_UNIT_TOKENS)),
      cacheHitMicros: Number((hit + BigInt(RATE_UNIT_TOKENS / 2)) / BigInt(RATE_UNIT_TOKENS)),
      outputMicros: Number((out + BigInt(RATE_UNIT_TOKENS / 2)) / BigInt(RATE_UNIT_TOKENS)),
    },
    // DeepSeek publishes no separate cache-write price; the bucket is displayed
    // but never charged, rather than silently billed at the hit rate.
    cacheWriteBilled: false,
  }
}

/**
 * Build the schedule list actually offered to the resolver.
 * @param {object} [options]
 * @param {readonly object[]} [options.contractual] - user-configured agreements.
 * @param {readonly object[]} [options.schedules] - replaces the built-in list when given.
 * @returns {object[]}
 */
export function buildSchedules({ contractual = [], schedules } = {}) {
  const base = schedules ?? [DEEPSEEK_PUBLIC_SCHEDULE]
  return [...base, ...contractual]
}
