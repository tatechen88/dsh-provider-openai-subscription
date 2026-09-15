/**
 * Configuration for the built-in usage meter.
 *
 * The meter's settings are this plugin's own, so they live in its state
 * directory behind {@link ./settings-store.js} rather than in a DSH settings
 * registry namespace: registering one would require a schemastery schema, and
 * this plugin declares no dependencies on purpose so that a failed load can
 * never stop DSH from starting. All parsing is tolerant: an unknown value falls
 * back to a documented default rather than disabling the meter.
 *
 * @module dsh-provider-openai-subscription/usage/config
 */

import { MICROS_PER_UNIT, PEAK_WINDOWS } from './pricing.js'

/** Declared account kinds. A declaration is evidence of intent, not of identity. */
export const ACCOUNT_KINDS = Object.freeze(['unknown', 'personal', 'enterprise'])

/** Time zones the ledger and cost windows can use. */
export const METER_TIME_ZONES = Object.freeze(['system', 'UTC', 'Asia/Shanghai'])

/** Currencies a contract may be quoted in. */
const CONTRACT_CURRENCIES = Object.freeze(['CNY', 'USD', 'EUR'])

/** Default meter configuration. */
export const DEFAULT_METER_CONFIG = Object.freeze({
  accountKind: 'unknown',
  displayCurrency: 'CNY',
  timeZone: 'system',
  hideBalance: false,
  hideCost: false,
  deepseekBalance: true,
  /**
   * Whether every provider DSH has registered is metered, not only the vendors
   * this plugin can read accounts for. A vendor another plugin adds is then
   * counted from its first call instead of waiting for a release here.
   */
  autoProviders: true,
  /**
   * Whether the vendor's own price page is read to price a model the built-in
   * snapshot does not carry. Off by default: it is the only outbound request this
   * meter makes that does not answer with the account's own state.
   */
  refreshPublicPrices: false,
  /**
   * Raw facts older than this many days are folded into one rollup per day and
   * route at startup, so the file stays bounded while every window total
   * survives the fold. Per-session detail keeps this window as its horizon.
   * 0 keeps every fact exactly as it happened.
   */
  retentionDays: 90,
  contractualSchedules: Object.freeze([]),
})

/**
 * Convert one user-entered per-million price into integer micro units.
 * @param {unknown} value
 * @returns {number|undefined}
 */
export function priceToMicros(value) {
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(parsed) || parsed < 0) return undefined
  const micros = Math.round(parsed * MICROS_PER_UNIT)
  return Number.isSafeInteger(micros) ? micros : undefined
}

/**
 * Convert one contractual entry into a price schedule.
 *
 * The off-peak band is the baseline: an entry with no complete off-peak rate
 * has no price for most of the day and is dropped, like any other incomplete
 * one — as is a rate that is present but unreadable, and a validity bound that
 * is present but unparseable. A half-understood agreement must never price
 * calls at zero, and a mistyped end date must never make an agreement
 * permanent.
 *
 * A resolved schedule is taken as it is: `status: 'contractual'` marks the
 * shape this function itself produces, whose rates already count micro units.
 * Without that, normalizing an already resolved configuration would multiply
 * every contract rate by 10^6 a second time.
 *
 * The two bands follow the official peak windows, because an agreement states
 * prices per band, not which hours are peak.
 *
 * @param {unknown} entry
 * @param {number} index
 * @returns {object|undefined}
 */
export function toContractualSchedule(entry, index = 0) {
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return undefined
  const record = /** @type {Record<string, unknown>} */ (entry)
  const models = record.models
  if (models === null || typeof models !== 'object' || Array.isArray(models)) return undefined
  const currency = typeof record.currency === 'string' && CONTRACT_CURRENCIES.includes(record.currency.toUpperCase())
    ? record.currency.toUpperCase()
    : undefined
  if (currency === undefined) return undefined

  const resolved = record.status === 'contractual'
  const validFrom = readBound(record.validFrom)
  const validTo = readBound(record.validTo)
  if (validFrom === INVALID_BOUND || validTo === INVALID_BOUND) return undefined

  /** @type {Record<string, object>} */
  const parsedModels = {}
  for (const [model, bands] of Object.entries(models)) {
    const name = model.trim()
    if (name.length === 0 || bands === null || typeof bands !== 'object') continue
    const rates = /** @type {Record<string, unknown>} */ (bands)
    const offPeak = readBand(rates.offPeak ?? rates)
    const peak = readBand(rates.peak)
    if (offPeak === undefined) continue
    parsedModels[name] = {
      offPeak,
      ...(peak === undefined ? {} : { peak }),
    }
  }
  if (Object.keys(parsedModels).length === 0) return undefined

  const label = typeof record.label === 'string' && record.label.trim().length > 0 ? record.label.trim() : `Contract ${index + 1}`
  return {
    id: typeof record.id === 'string' && record.id.trim().length > 0 ? record.id.trim() : `contract-${index + 1}`,
    label,
    provider: 'deepseek-official',
    status: 'contractual',
    currency,
    windows: PEAK_WINDOWS,
    ...(validFrom === undefined ? {} : { validFrom }),
    ...(validTo === undefined ? {} : { validTo }),
    models: parsedModels,
  }

  /** Read one band's three rates, from currency units or from stored micro units. */
  function readBand(band) {
    if (band === null || typeof band !== 'object') return undefined
    const rates = /** @type {Record<string, unknown>} */ (band)
    const convert = resolved ? asMicros : priceToMicros
    const cacheMiss = convert(rates.cacheMiss)
    const cacheHit = convert(rates.cacheHit)
    const output = convert(rates.output)
    if (cacheMiss === undefined || cacheHit === undefined || output === undefined) return undefined
    return { cacheMiss, cacheHit, output }
  }
}

/** A resolved band states micro units directly, so it is accepted as-is. */
function asMicros(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

/** Marks a bound that is present but unparseable; it drops the whole entry. */
const INVALID_BOUND = Symbol('invalid-bound')

/**
 * Read one validity bound, keeping "absent" distinct from "unparseable".
 * @param {unknown} value
 * @returns {string|symbol|undefined}
 */
function readBound(value) {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') return INVALID_BOUND
  const text = value.trim()
  if (text.length === 0) return undefined
  return Number.isFinite(Date.parse(text)) ? text : INVALID_BOUND
}

/**
 * Normalize the meter's settings section.
 * @param {unknown} raw
 * @returns {object} the resolved configuration.
 */
export function normalizeMeterConfig(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ...DEFAULT_METER_CONFIG, contractualSchedules: [] }
  }
  const record = /** @type {Record<string, unknown>} */ (raw)
  const contracts = Array.isArray(record.contractualSchedules) ? record.contractualSchedules : []
  return {
    accountKind: ACCOUNT_KINDS.includes(record.accountKind) ? record.accountKind : DEFAULT_METER_CONFIG.accountKind,
    displayCurrency: typeof record.displayCurrency === 'string' && /^[A-Z]{3}$/.test(record.displayCurrency)
      ? record.displayCurrency
      : DEFAULT_METER_CONFIG.displayCurrency,
    timeZone: METER_TIME_ZONES.includes(record.timeZone) ? record.timeZone : DEFAULT_METER_CONFIG.timeZone,
    hideBalance: record.hideBalance === true,
    hideCost: record.hideCost === true,
    deepseekBalance: record.deepseekBalance !== false,
    autoProviders: record.autoProviders !== false,
    refreshPublicPrices: record.refreshPublicPrices === true,
    retentionDays: Number.isSafeInteger(record.retentionDays) && record.retentionDays >= 0
      ? record.retentionDays
      : DEFAULT_METER_CONFIG.retentionDays,
    contractualSchedules: contracts
      .map((entry, index) => toContractualSchedule(entry, index))
      .filter((entry) => entry !== undefined),
  }
}
