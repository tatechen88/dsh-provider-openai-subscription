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
export const USAGE_LEDGER_SCHEMA_VERSION = 2

/**
 * File versions this build reads.
 *
 * A v2 file may hold rollup entries alongside raw ones; a v1 file holds only raw
 * facts, which every v2 rule reads exactly as v1 did. Anything else is preserved
 * beside the file and raised, never overwritten.
 */
const READABLE_SCHEMA_VERSIONS = Object.freeze([1, USAGE_LEDGER_SCHEMA_VERSION])

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
  let calls = 0
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
    const factUsage = entryUsageOf(entry)
    const merged = addBuckets(usage, factUsage)
    usage.inputTokens = merged.inputTokens
    usage.cacheReadTokens = merged.cacheReadTokens
    usage.cacheWriteTokens = merged.cacheWriteTokens
    usage.outputTokens = merged.outputTokens
    reasoningTokens += factUsage.reasoningTokens ?? 0
    calls += entryCalls(entry)
    const amounts = entryAmounts(entry)
    for (const [currency, micros] of Object.entries(amounts)) {
      byCurrency[currency] = (byCurrency[currency] ?? 0) + micros
    }
    for (const [key, bucket] of [[entryProvider(entry), byProvider], [entryModel(entry), byModel]]) {
      const slot = bucket[key] ?? { calls: 0, usage: emptyBuckets(), amountMicros: {} }
      slot.calls += entryCalls(entry)
      const next = addBuckets(slot.usage, factUsage)
      slot.usage = next
      for (const [currency, micros] of Object.entries(amounts)) {
        slot.amountMicros[currency] = (slot.amountMicros[currency] ?? 0) + micros
      }
      bucket[key] = slot
    }
  }
  return {
    calls,
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
 * The facts of one route, or every fact when no route is named.
 *
 * A route is part of the question rather than a filter a caller applies later:
 * the numbers an indicator shows belong to the model the session is running, and
 * every other route's tokens would otherwise be added to them.
 * @param {object[]} entries
 * @param {string|undefined} provider - wire provider id.
 * @returns {object[]}
 */
function ofProvider(entries, provider) {
  if (typeof provider !== 'string' || provider.length === 0) return entries
  return entries.filter((entry) => entryProvider(entry) === provider)
}

/**
 * Field accessors over the two entry shapes.
 *
 * A raw entry is `{ fact, quote }` as the collector produced it. A rollup is the
 * compaction of many raw entries into one day of one route: it states its totals
 * directly instead of carrying a fact that never happened, and it carries no
 * quote — pricing already happened per call before the fold.
 * @param {object} entry
 * @returns {number}
 */
function entryStartedAt(entry) {
  return entry.rollup === true ? entry.startedAt : entry.fact.startedAt
}

/** @param {object} entry */
function entryProvider(entry) {
  return entry.rollup === true ? entry.provider : entry.fact.provider
}

/** @param {object} entry */
function entryModel(entry) {
  return entry.rollup === true ? entry.model : entry.fact.model
}

/** @param {object} entry */
function entryCalls(entry) {
  return entry.rollup === true ? entry.calls : 1
}

/** @param {object} entry */
function entryUsageOf(entry) {
  return entry.rollup === true ? entry.usage : entry.fact.usage
}

/**
 * Amounts one entry contributes, per currency in integer micro units.
 * @param {object} entry
 * @returns {Record<string, number>}
 */
function entryAmounts(entry) {
  if (entry.rollup === true) return entry.amountMicrosByCurrency ?? {}
  const quote = entry.quote
  if (quote?.status !== 'priced' || typeof quote.currency !== 'string' || !Number.isFinite(quote.amountMicros)) return {}
  return { [quote.currency]: quote.amountMicros }
}

/**
 * Whether one stored entry can be read back.
 *
 * `aggregate` reads the fact's token buckets and the quote's status, so an
 * entry missing either fails every later summary rather than one call. A rollup
 * is read by its own contract instead, because it states totals rather than a
 * fact that never happened.
 * @param {unknown} entry
 * @returns {boolean}
 */
function isReadableEntry(entry) {
  if (entry === null || typeof entry !== 'object') return false
  if (entry.rollup === true) return isReadableRollup(entry)
  const candidate = /** @type {{fact?: unknown, quote?: unknown}} */ (entry)
  if (candidate.quote === null || typeof candidate.quote !== 'object') return false
  return validateUsageFact(candidate.fact).ok
}

/**
 * Whether a stored rollup carries everything a summary reads.
 * @param {object} entry
 * @returns {boolean}
 */
function isReadableRollup(entry) {
  return typeof entry.day === 'string'
    && typeof entry.provider === 'string'
    && typeof entry.model === 'string'
    && Number.isFinite(entry.startedAt)
    && Number.isSafeInteger(entry.calls) && entry.calls > 0
    && entry.usage !== null && typeof entry.usage === 'object'
    && entry.amountMicrosByCurrency !== null && typeof entry.amountMicrosByCurrency === 'object'
}

/** Ledger for the built-in usage meter. */
export class UsageLedger {
  /**
   * @param {object} options
   * @param {string} options.path - absolute ledger file path.
   * @param {() => number} [options.now]
   * @param {number} [options.debounceMs]
   * @param {string} [options.timeZone] - 'system' | 'UTC' | 'Asia/Shanghai'.
   * @param {number} [options.retentionDays] - raw facts older than this many days
   *   are folded into day rollups at open; 0 keeps every fact as it happened.
   */
  constructor({ path, now = Date.now, debounceMs = USAGE_LEDGER_DEBOUNCE_MS, timeZone = 'system', retentionDays = 0 }) {
    this.path = path
    this.now = now
    this.debounceMs = debounceMs
    this.timeZone = timeZone
    this.retentionDays = retentionDays
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
    /**
     * Bumped whenever the entries change. The service caches its view slices on
     * this counter instead of re-reading the whole ledger on every poll.
     */
    this.mutations = 0
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
    if (!READABLE_SCHEMA_VERSIONS.includes(version)) {
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
      if (entry.rollup === true) {
        // A rollup states its own identity; it never takes part in the call-id
        // map, because no real call id can collide with it and none should be
        // silently dropped for looking like one.
        this.entries.push(entry)
      } else {
        const callId = entry.fact.callId
        // A duplicate call id means two writers appended the same call. The later
        // entry wins, which is what re-recording it would have done.
        const existing = this.byCallId.get(callId)
        if (existing !== undefined) this.entries.splice(this.entries.indexOf(existing), 1)
        this.entries.push(entry)
        this.byCallId.set(callId, entry)
      }
      while (this.entries.length > USAGE_LEDGER_MAX_FACTS) this.#dropOldest()
    }
    this.mutations += 1
    // Compaction runs here rather than on a timer so it never competes with a
    // write: the fold is pure array work, and the rewritten file follows through
    // the ordinary debounced write.
    this.compact()
    return { facts: this.entries.length }
  }

  /**
   * Drop the oldest entry, keeping the call-id map consistent with what leaves.
   */
  #dropOldest() {
    const dropped = this.entries.shift()
    if (dropped.fact !== undefined && this.byCallId.get(dropped.fact.callId) === dropped) {
      this.byCallId.delete(dropped.fact.callId)
    }
  }

  /**
   * Fold raw facts older than the retention window into one rollup per day and
   * route.
   *
   * Dropping old facts would silently rewrite the totals the windows report, so
   * they are folded instead: token buckets and per-currency amounts are summed,
   * and the windows only ever add those, so every total survives the fold
   * exactly. A rollup carries no session, so per-session detail is the one thing
   * that keeps the retention window as its horizon. Running twice folds nothing
   * the second time: rollups are skipped by their own marker.
   * @returns {{rolled: number}} how many raw facts were folded.
   */
  compact() {
    if (this.retentionDays <= 0) return { rolled: 0 }
    const cutoff = this.now() - this.retentionDays * 86_400_000
    const groups = new Map()
    const kept = []
    let rolled = 0
    for (const entry of this.entries) {
      if (entry.rollup === true || entryStartedAt(entry) >= cutoff) {
        kept.push(entry)
        continue
      }
      rolled += 1
      const day = calendarKey(entryStartedAt(entry), this.timeZone).day
      const key = `${day}\u0000${entryProvider(entry)}\u0000${entryModel(entry)}`
      const group = groups.get(key) ?? {
        rollup: true,
        day,
        provider: entryProvider(entry),
        model: entryModel(entry),
        // Noon UTC lands on the folded day in every zone this build supports
        // (UTC, Asia/Shanghai, or a local offset from −12 to +11), so the
        // rollup is bucketed back into the day it summarizes.
        startedAt: Date.parse(`${day}T12:00:00Z`),
        usage: emptyBuckets(),
        amountMicrosByCurrency: {},
        calls: 0,
      }
      group.usage = addBuckets(group.usage, entryUsageOf(entry))
      for (const [currency, micros] of Object.entries(entryAmounts(entry))) {
        group.amountMicrosByCurrency[currency] = (group.amountMicrosByCurrency[currency] ?? 0) + micros
      }
      group.calls += entryCalls(entry)
      groups.set(key, group)
    }
    if (rolled === 0) return { rolled: 0 }
    this.entries = [...groups.values(), ...kept].sort((left, right) => entryStartedAt(left) - entryStartedAt(right))
    this.byCallId.clear()
    for (const entry of this.entries) {
      if (entry.fact !== undefined) this.byCallId.set(entry.fact.callId, entry)
    }
    this.mutations += 1
    this.schedule()
    return { rolled }
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
    while (this.entries.length > USAGE_LEDGER_MAX_FACTS) this.#dropOldest()
    this.mutations += 1
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
      || !READABLE_SCHEMA_VERSIONS.includes(parsed.schemaVersion)) {
      await rename(this.path, `${this.path}.corrupt-${this.now()}`)
      return
    }
    // Rollups are each instance's own fold: a foreign one would duplicate this
    // instance's on the next compaction, so only raw facts merge.
    const known = new Set(this.entries.filter((entry) => entry.fact !== undefined).map((entry) => entry.fact.callId))
    const foreign = []
    for (const entry of parsed.entries) {
      if (entry.rollup === true) continue
      if (!isReadableEntry(entry) || known.has(entry.fact.callId)) continue
      foreign.push(entry)
    }
    if (foreign.length === 0) return
    // Their facts happened before ours was the newest, so they lead the list.
    this.entries = [...foreign, ...this.entries]
    for (const entry of foreign) this.byCallId.set(entry.fact.callId, entry)
    while (this.entries.length > USAGE_LEDGER_MAX_FACTS) this.#dropOldest()
    this.mutations += 1
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
   * Totals for one session, optionally of one route only.
   * @param {string} sessionId
   * @param {string} [provider] - wire provider id; every route when omitted.
   * @returns {object}
   */
  sessionSummary(sessionId, provider) {
    // A rollup states no session: per-session detail keeps the retention window
    // as its horizon, which is the one thing compaction costs.
    return aggregate(ofProvider(this.entries, provider)
      .filter((entry) => entry.fact !== undefined && entry.fact.sessionId === sessionId))
  }

  /**
   * Totals for one calendar range, optionally of one route only.
   * @param {'today'|'month'|'all'} range
   * @param {string} [provider] - wire provider id; every route when omitted.
   * @returns {object}
   */
  summary(range, provider) {
    const scoped = ofProvider(this.entries, provider)
    if (range === 'all') return aggregate(scoped)
    const now = this.now()
    const key = calendarKey(now, this.timeZone)
    const field = range === 'month' ? 'month' : 'day'
    const wanted = key[field]
    return aggregate(scoped.filter((entry) => calendarKey(entryStartedAt(entry), this.timeZone)[field] === wanted))
  }

  /**
   * Totals of one session, newest last. Used by the session-scoped surfaces and
   * by tests that need the underlying facts rather than the totals.
   * @param {string} sessionId
   * @returns {object[]}
   */
  sessionFacts(sessionId) {
    return this.entries.filter((entry) => entry.fact !== undefined && entry.fact.sessionId === sessionId)
  }

  /**
   * Models that ran without a rate, most used first.
   *
   * Only a route whose vendor publishes a price table can be missing a rate: a
   * vendor that publishes none records every call as unpriced by design, which is
   * its normal state rather than a gap anyone can close. A caller that knows
   * which routes are priced passes them, and gets back only the real gaps — the
   * shape a model takes on the day it ships.
   * @param {readonly string[]} [providers] - routes to consider; every route when omitted.
   * @returns {Array<{provider: string, model: string, calls: number, lastSeenAt: number, reason: string}>}
   */
  unpricedModels(providers) {
    const wanted = Array.isArray(providers) && providers.length > 0 ? new Set(providers) : undefined
    const seen = new Map()
    for (const entry of this.entries) {
      const quote = entry.quote
      if (quote === null || typeof quote !== 'object' || quote.status !== 'unpriced') continue
      const provider = entryProvider(entry)
      const model = entryModel(entry)
      if (wanted !== undefined && !wanted.has(provider)) continue
      const key = `${provider}\u0000${model}`
      const current = seen.get(key) ?? {
        provider,
        model,
        calls: 0,
        lastSeenAt: 0,
        reason: quote.reason,
      }
      current.calls += entryCalls(entry)
      current.lastSeenAt = Math.max(current.lastSeenAt, entryStartedAt(entry))
      seen.set(key, current)
    }
    return [...seen.values()].sort((left, right) => right.calls - left.calls || left.model.localeCompare(right.model))
  }
}
