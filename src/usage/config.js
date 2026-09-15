/**
 * Configuration for the built-in usage meter.
 *
 * The meter's own settings live in the plugin's DSH settings namespace, not in
 * the bootstrap config, so a user can change them without restarting DSH.  All
 * parsing is tolerant: an unknown value falls back to a documented default
 * rather than disabling the meter.
 *
 * @module dsh-provider-openai-subscription/usage/config
 */

import { MICROS_PER_UNIT } from './pricing.js'

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
  showSidebar: true,
  showSessionDock: true,
  hideBalance: false,
  hideCost: false,
  deepseekBalance: true,
  deepseekBaseURL: '',
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
 * An entry without a usable rate for at least one band is dropped: a partially
 * understood agreement must not silently price calls at zero.
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

  /** @type {Record<string, object>} */
  const parsedModels = {}
  for (const [model, bands] of Object.entries(models)) {
    if (model.trim().length === 0 || bands === null || typeof bands !== 'object') continue
    const rates = /** @type {Record<string, unknown>} */ (bands)
    const offPeak = readBand(rates.offPeak ?? rates)
    const peak = readBand(rates.peak)
    if (offPeak === undefined && peak === undefined) continue
    parsedModels[model] = {
      ...(offPeak === undefined ? {} : { offPeak }),
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
    ...(typeof record.validFrom === 'string' ? { validFrom: record.validFrom } : {}),
    ...(typeof record.validTo === 'string' ? { validTo: record.validTo } : {}),
    models: parsedModels,
  }

  /** Read one band's three rates. */
  function readBand(band) {
    if (band === null || typeof band !== 'object') return undefined
    const rates = /** @type {Record<string, unknown>} */ (band)
    const cacheMiss = priceToMicros(rates.cacheMiss)
    const cacheHit = priceToMicros(rates.cacheHit)
    const output = priceToMicros(rates.output)
    if (cacheMiss === undefined || cacheHit === undefined || output === undefined) return undefined
    return { cacheMiss, cacheHit, output }
  }
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
    showSidebar: record.showSidebar !== false,
    showSessionDock: record.showSessionDock !== false,
    hideBalance: record.hideBalance === true,
    hideCost: record.hideCost === true,
    deepseekBalance: record.deepseekBalance !== false,
    deepseekBaseURL: typeof record.deepseekBaseURL === 'string' ? record.deepseekBaseURL.trim() : '',
    contractualSchedules: contracts
      .map((entry, index) => toContractualSchedule(entry, index))
      .filter((entry) => entry !== undefined),
  }
}
