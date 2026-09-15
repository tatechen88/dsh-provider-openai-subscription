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

import { mkdir, open, readFile, rename } from 'node:fs/promises'
import { dirname } from 'node:path'
import { addBuckets, emptyBuckets, promptTokensOf, validateUsageFact } from './types.js'

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
  // Provider, model and currency all reach these maps as keys, and all three
  // come from upstream data: a null prototype keeps `__proto__` an ordinary key
  // instead of the prototype of every bucket.
  /** @type {Record<string, number>} */
  const byCurrency = Object.create(null)
  /** @type {Record<string, {calls: number, usage: object, amountMicros: Record<string, number>}>} */
  const byProvider = Object.create(null)
  /** @type {Record<string, {calls: number, usage: object, amountMicros: Record<string, number>}>} */
  const byModel = Object.create(null)
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
    // Ordinary objects on the way out. The null prototype above exists to keep
    // the lookups safe while keys arrive; callers compare and serialize these
    // maps as plain records.
    amountMicrosByCurrency: { ...byCurrency },
    byProvider: { ...byProvider },
    byModel: { ...byModel },
  }
}

/**
 * Whether one stored entry can be read back.
 *
 * `aggregate` reads the fact's token buckets and the quote's status, so an
 * entry missing either fails every later summary rather than one call.
 * @param {unknown} entry
 * @returns {boolean}
 */
function isReadableEntry(entry) {
  if (entry === null || typeof entry !== 'object') return false
  const candidate = /** @type {{fact?: unknown, quote?: unknown}} */ (entry)
  if (candidate.quote === null || typeof candidate.quote !== 'object') return false
  return validateUsageFact(candidate.fact).ok
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
    /** Serializes overlapping writes so the newest snapshot lands last. */
    this.writeChain = undefined
    /** Names temp files, so two writes in one millisecond cannot collide. */
    this.writeSequence = 0
    this.closed = false
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
      // An entry that cannot be summed would turn every later summary into a
      // failed request, and the file would be written back with it. One bad
      // entry therefore quarantines the ledger, exactly like a bad document.
      if (!isReadableEntry(entry)) {
        const backupPath = `${this.path}.corrupt-${this.now()}`
        await rename(this.path, backupPath)
        throw new UsageLedgerCorruptError(
          `usage ledger at ${this.path} holds an unreadable entry; it was preserved at ${backupPath}`,
          backupPath,
        )
      }
      const callId = entry.fact.callId
      // A duplicate call id means two writers appended the same call. The later
      // entry wins, which is what re-recording it would have done.
      const existing = this.byCallId.get(callId)
      if (existing !== undefined) this.entries.splice(this.entries.indexOf(existing), 1)
      this.entries.push(entry)
      this.byCallId.set(callId, entry)
      while (this.entries.length > USAGE_LEDGER_MAX_FACTS) {
        const dropped = this.entries.shift()
        if (this.byCallId.get(dropped.fact.callId) === dropped) this.byCallId.delete(dropped.fact.callId)
      }
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
      // Only forget the call id when the map still points at this entry: a
      // duplicate appended later must stay recordable as itself.
      if (this.byCallId.get(dropped.fact.callId) === dropped) this.byCallId.delete(dropped.fact.callId)
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
   *
   * Writes are serialized through one chain: a debounce-timer write can fire
   * while a `flush()` is already in flight, and two overlapping renames would
   * let the older snapshot land last. Chaining also keeps the temp names
   * distinct, since a counter rather than a clock names them.
   * @returns {Promise<void>}
   */
  async write() {
    const next = (this.writeChain ?? Promise.resolve()).then(() => this.#writeOnce())
    // A failed write must not poison the chain for later ones.
    this.writeChain = next.catch(() => {})
    return next
  }

  /**
   * Fold in what another instance appended since this one last wrote, then
   * serialize and rename one snapshot.
   *
   * Two DSH instances can share one home, and whichever wrote second would
   * otherwise drop every fact the other recorded. A duplicate call id keeps the
   * entry this instance already priced and showed. A file this build cannot read
   * is moved aside rather than overwritten.
   */
  async #writeOnce() {
    await this.#mergeFromDisk()
    const body = JSON.stringify({
      schemaVersion: USAGE_LEDGER_SCHEMA_VERSION,
      updatedAt: this.now(),
      entries: this.entries,
    })
    await mkdir(dirname(this.path), { recursive: true })
    this.writeSequence += 1
    const temp = `${this.path}.tmp-${process.pid}-${this.writeSequence}`
    const handle = await open(temp, 'w', 0o600)
    try {
      await handle.writeFile(`${body}\n`, { encoding: 'utf8' })
      // Renaming before the bytes reach the disk can leave a truncated file
      // behind after a power loss, which the loader then has to quarantine.
      await handle.sync()
    } finally {
      await handle.close()
    }
    await rename(temp, this.path)
  }

  /** Merge the on-disk ledger into this instance's entries, by call id. */
  async #mergeFromDisk() {
    let raw
    try {
      raw = await readFile(this.path, 'utf8')
    } catch {
      // No file yet is the ordinary first write.
      return
    }
    let parsed
    try {
      parsed = JSON.parse(raw)
    } catch {
      parsed = undefined
    }
    if (parsed === null || typeof parsed !== 'object' || !Array.isArray(parsed.entries)
      || parsed.schemaVersion !== USAGE_LEDGER_SCHEMA_VERSION) {
      await rename(this.path, `${this.path}.corrupt-${this.now()}`)
      return
    }
    const known = new Set(this.entries.map((entry) => entry.fact.callId))
    const foreign = []
    for (const entry of parsed.entries) {
      if (!isReadableEntry(entry) || known.has(entry.fact.callId)) continue
      foreign.push(entry)
    }
    if (foreign.length === 0) return
    // Their facts happened before ours was the newest, so they lead the list.
    this.entries = [...foreign, ...this.entries]
    for (const entry of foreign) this.byCallId.set(entry.fact.callId, entry)
    while (this.entries.length > USAGE_LEDGER_MAX_FACTS) {
      const dropped = this.entries.shift()
      if (this.byCallId.get(dropped.fact.callId) === dropped) this.byCallId.delete(dropped.fact.callId)
    }
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
    await this.write()
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
   * Totals of one session, newest last. Used by the session-scoped surfaces and
   * by tests that need the underlying facts rather than the totals.
   * @param {string} sessionId
   * @returns {object[]}
   */
  sessionFacts(sessionId) {
    return this.entries.filter((entry) => entry.fact.sessionId === sessionId)
  }
}
