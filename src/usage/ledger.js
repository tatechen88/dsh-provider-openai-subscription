/**
 * Durable usage ledger.
 *
 * The ledger stores append-only usage facts together with the charge quoted at
 * the moment of the call.  Aggregates are views over those facts, so a price
 * change never rewrites history and a summary can always be recomputed.
 *
 * Writes are debounced and atomic (temp file + rename); `flush()` and `close()`
 * await the newest bytes.  A file that cannot be parsed is moved aside and the
 * failure is reported instead of being read as an empty ledger.
 *
 * @module dsh-provider-openai-subscription/usage/ledger
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { addBuckets, emptyBuckets, promptTokensOf } from './types.js'

/** Storage schema revision; a successor reads older files through a migration. */
export const USAGE_LEDGER_SCHEMA_VERSION = 1

/** Facts retained before the oldest are dropped. */
export const USAGE_LEDGER_MAX_FACTS = 20_000

/** Write debounce in milliseconds. */
export const USAGE_LEDGER_DEBOUNCE_MS = 2_000

/** Zone offsets, in minutes east of UTC, for the supported ledger zones. */
const ZONE_OFFSETS = Object.freeze({ UTC: 0, 'Asia/Shanghai': 480 })

/** Raised when the stored ledger cannot be read; the original is preserved. */
export class UsageLedgerCorruptError extends Error {
  /**
   * @param {string} message
   * @param {string} backupPath
   */
  constructor(message, backupPath) {
    super(message)
    this.name = 'UsageLedgerCorruptError'
    this.code = 'ledger-corrupt'
    this.backupPath = backupPath
  }
}

/**
 * Calendar key of one instant in the configured zone.
 * @param {number} atMs
 * @param {string} timeZone - 'system', 'UTC', or an offset name in {@link ZONE_OFFSETS}.
 * @returns {{day: string, month: string}}
 */
export function calendarKey(atMs, timeZone = 'system') {
  if (timeZone === 'system') {
    const local = new Date(atMs)
    const month = String(local.getMonth() + 1).padStart(2, '0')
    const day = String(local.getDate()).padStart(2, '0')
    return { day: `${local.getFullYear()}-${month}-${day}`, month: `${local.getFullYear()}-${month}` }
  }
  const offset = ZONE_OFFSETS[timeZone]
  if (offset === undefined) throw new TypeError(`unknown ledger time zone "${timeZone}"`)
  const shifted = new Date(atMs + offset * 60_000)
  const month = String(shifted.getUTCMonth() + 1).padStart(2, '0')
  const day = String(shifted.getUTCDate()).padStart(2, '0')
  return { day: `${shifted.getUTCFullYear()}-${month}-${day}`, month: `${shifted.getUTCFullYear()}-${month}` }
}

/**
 * Fold facts into one totals record.
 * @param {readonly object[]} entries
 * @returns {object}
 */
function aggregate(entries) {
  const usage = emptyBuckets()
  let reasoningTokens = 0
  /** @type {Record<string, number>} */
  const byCurrency = {}
  /** @type {Record<string, {calls: number, usage: object, amountMicros: Record<string, number>}>} */
  const byProvider = {}
  /** @type {Record<string, {calls: number, usage: object, amountMicros: Record<string, number>}>} */
  const byModel = {}
  for (const entry of entries) {
    const fact = entry.fact
    const merged = addBuckets(usage, fact.usage)
    usage.inputTokens = merged.inputTokens
    usage.cacheReadTokens = merged.cacheReadTokens
    usage.cacheWriteTokens = merged.cacheWriteTokens
    usage.outputTokens = merged.outputTokens
    reasoningTokens += fact.usage.reasoningTokens ?? 0
    const currency = entry.quote?.currency
    if (entry.quote?.status === 'priced' && typeof currency === 'string' && Number.isFinite(entry.quote.amountMicros)) {
      byCurrency[currency] = (byCurrency[currency] ?? 0) + entry.quote.amountMicros
    }
    for (const [key, bucket] of [[fact.provider, byProvider], [fact.model, byModel]]) {
      const slot = bucket[key] ?? { calls: 0, usage: emptyBuckets(), amountMicros: {} }
      slot.calls += 1
      const next = addBuckets(slot.usage, fact.usage)
      slot.usage = next
      if (entry.quote?.status === 'priced' && typeof currency === 'string') {
        slot.amountMicros[currency] = (slot.amountMicros[currency] ?? 0) + entry.quote.amountMicros
      }
      bucket[key] = slot
    }
  }
  return {
    calls: entries.length,
    usage: { ...usage, reasoningTokens, promptTokens: promptTokensOf(usage) },
    amountMicrosByCurrency: byCurrency,
    byProvider,
    byModel,
  }
}

/** Ledger for the built-in usage meter. */
export class UsageLedger {
  /**
   * @param {object} options
   * @param {string} options.path - absolute ledger file path.
   * @param {() => number} [options.now]
   * @param {number} [options.debounceMs]
   * @param {string} [options.timeZone] - 'system' | 'UTC' | 'Asia/Shanghai'.
   */
  constructor({ path, now = Date.now, debounceMs = USAGE_LEDGER_DEBOUNCE_MS, timeZone = 'system' }) {
    this.path = path
    this.now = now
    this.debounceMs = debounceMs
    this.timeZone = timeZone
    /** @type {object[]} */
    this.entries = []
    /** @type {Map<string, object>} */
    this.byCallId = new Map()
    this.timer = undefined
    /** @type {Promise<void>|undefined} */
    this.pending = undefined
    this.closed = false
    this.dropped = 0
  }

  /**
   * Load the stored ledger, migrating or quarantining it as needed.
   * @returns {Promise<{facts: number, quarantined?: string}>}
   */
  async open() {
    let raw
    try {
      raw = await readFile(this.path, 'utf8')
    } catch (error) {
      if (error && typeof error === 'object' && error.code === 'ENOENT') return { facts: 0 }
      throw error
    }
    let parsed
    try {
      parsed = JSON.parse(raw)
    } catch {
      parsed = undefined
    }
    if (parsed === null || typeof parsed !== 'object' || !Array.isArray(parsed.entries)) {
      const backupPath = `${this.path}.corrupt-${this.now()}`
      await rename(this.path, backupPath)
      throw new UsageLedgerCorruptError(
        `usage ledger at ${this.path} is unreadable; it was preserved at ${backupPath}`,
        backupPath,
      )
    }
    const version = parsed.schemaVersion
    if (version !== USAGE_LEDGER_SCHEMA_VERSION) {
      const backupPath = `${this.path}.v${String(version)}-${this.now()}`
      await rename(this.path, backupPath)
      throw new UsageLedgerCorruptError(
        `usage ledger schema v${String(version)} is not readable by v${USAGE_LEDGER_SCHEMA_VERSION}; it was preserved at ${backupPath}`,
        backupPath,
      )
    }
    for (const entry of parsed.entries) {
      if (entry === null || typeof entry !== 'object' || entry.fact === null || typeof entry.fact !== 'object') continue
      if (typeof entry.fact.callId !== 'string') continue
      this.entries.push(entry)
      this.byCallId.set(entry.fact.callId, entry)
    }
    return { facts: this.entries.length }
  }

  /**
   * Append one fact and its quote. The call id makes this idempotent.
   * @param {object} fact - validated UsageFact.
   * @param {object} quote - ChargeQuote produced for that fact.
   * @returns {boolean} true when a new fact was stored.
   */
  record(fact, quote) {
    if (this.closed) return false
    if (this.byCallId.has(fact.callId)) return false
    const entry = { fact, quote }
    this.entries.push(entry)
    this.byCallId.set(fact.callId, entry)
    while (this.entries.length > USAGE_LEDGER_MAX_FACTS) {
      const dropped = this.entries.shift()
      this.byCallId.delete(dropped.fact.callId)
      this.dropped += 1
    }
    this.schedule()
    return true
  }

  /** Arm the debounced write. */
  schedule() {
    if (this.closed || this.timer !== undefined) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      void this.write().catch(() => {})
    }, this.debounceMs)
    this.timer.unref?.()
  }

  /**
   * Write the current ledger atomically.
   * @returns {Promise<void>}
   */
  async write() {
    const body = JSON.stringify({
      schemaVersion: USAGE_LEDGER_SCHEMA_VERSION,
      updatedAt: this.now(),
      entries: this.entries,
    })
    await mkdir(dirname(this.path), { recursive: true })
    const temp = `${this.path}.tmp-${process.pid}-${this.now()}`
    await writeFile(temp, `${body}\n`, { encoding: 'utf8', mode: 0o600 })
    await rename(temp, this.path)
  }

  /**
   * Flush pending changes and await the durable write.
   * @returns {Promise<void>}
   */
  async flush() {
    if (this.timer !== undefined) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
    this.pending = this.write()
    try {
      await this.pending
    } finally {
      this.pending = undefined
    }
  }

  /**
   * Flush and stop accepting writes.
   * @returns {Promise<void>}
   */
  async close() {
    if (this.closed) return
    await this.flush()
    this.closed = true
  }

  /**
   * Totals for one session.
   * @param {string} sessionId
   * @returns {object}
   */
  sessionSummary(sessionId) {
    return aggregate(this.entries.filter((entry) => entry.fact.sessionId === sessionId))
  }

  /**
   * Totals for one calendar range.
   * @param {'today'|'month'|'all'} range
   * @returns {object}
   */
  summary(range) {
    if (range === 'all') return aggregate(this.entries)
    const now = this.now()
    const key = calendarKey(now, this.timeZone)
    const field = range === 'month' ? 'month' : 'day'
    const wanted = key[field]
    return aggregate(this.entries.filter((entry) => calendarKey(entry.fact.startedAt, this.timeZone)[field] === wanted))
  }

  /**
   * Facts of one session, newest last.
   * @param {string} sessionId
   * @returns {object[]}
   */
  sessionFacts(sessionId) {
    return this.entries.filter((entry) => entry.fact.sessionId === sessionId)
  }
}

/**
 * Create a ledger for one ledger file.
 * @param {object} options - forwarded to {@link UsageLedger}.
 * @returns {UsageLedger}
 */
export function createUsageLedger(options) {
  return new UsageLedger(options)
}
