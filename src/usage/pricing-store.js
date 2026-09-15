/**
 * The price table learned from the vendor's own page.
 *
 * This is a cache, not a preference: it lives under `storages/` beside the
 * ledger, it can be deleted at any time, and an unreadable file is ignored rather
 * than repaired. Deleting it only means the built-in snapshot prices calls again.
 *
 * The stored file also remembers the last attempt and why it failed, so a page
 * that stopped parsing is something the operator can see instead of something
 * that silently never updates.
 *
 * @module dsh-provider-openai-subscription/usage/pricing-store
 */

import { mkdir, open as openFile, readFile, rename } from 'node:fs/promises'
import { dirname } from 'node:path'

/** Version of the stored file. A file from another version is ignored. */
export const LEARNED_PRICE_SCHEMA_VERSION = 1

/** A finite number, or the fallback. */
function numberOr(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

/**
 * Whether a stored value is a price schedule this meter can use.
 * @param {unknown} value
 * @returns {boolean}
 */
function isSchedule(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const record = /** @type {Record<string, unknown>} */ (value)
  if (typeof record.id !== 'string' || typeof record.provider !== 'string') return false
  if (typeof record.currency !== 'string') return false
  return record.models !== null && typeof record.models === 'object' && !Array.isArray(record.models)
}

/** Learned price table store for one deployment. */
export class LearnedPriceStore {
  /**
   * @param {object} options
   * @param {string} options.path - absolute file path.
   * @param {() => number} [options.now]
   */
  constructor({ path, now = Date.now }) {
    this.path = path
    this.now = now
    /** @type {{schedule: object|undefined, fetchedAt: number, lastAttemptAt: number, lastError: string|undefined}} */
    this.data = { schedule: undefined, fetchedAt: 0, lastAttemptAt: 0, lastError: undefined }
    this.writes = Promise.resolve()
    this.sequence = 0
  }

  /** The learned schedule, or undefined when the built-in one is in force. */
  get schedule() {
    return this.data.schedule
  }

  /** When the learned schedule was read. */
  get fetchedAt() {
    return this.data.fetchedAt
  }

  /** When the last refresh was attempted, successfully or not. */
  get lastAttemptAt() {
    return this.data.lastAttemptAt
  }

  /** Why the last refresh failed, when it did. */
  get lastError() {
    return this.data.lastError
  }

  /**
   * Read what is on disk.
   *
   * A file that cannot be read is reported and then ignored: a broken cache must
   * never stop the meter from pricing calls with the built-in snapshot.
   * @returns {Promise<{loaded: boolean, reason?: string}>}
   */
  async open() {
    let parsed
    try {
      parsed = JSON.parse(await readFile(this.path, 'utf8'))
    } catch (error) {
      const missing = error !== null && typeof error === 'object' && error.code === 'ENOENT'
      return { loaded: false, ...(missing ? {} : { reason: error instanceof Error ? error.message : String(error) }) }
    }
    if (parsed === null || typeof parsed !== 'object' || parsed.schemaVersion !== LEARNED_PRICE_SCHEMA_VERSION) {
      return { loaded: false, reason: 'unsupported-schema' }
    }
    this.data = {
      schedule: isSchedule(parsed.schedule) ? parsed.schedule : undefined,
      fetchedAt: numberOr(parsed.fetchedAt, 0),
      lastAttemptAt: numberOr(parsed.lastAttemptAt, 0),
      lastError: typeof parsed.lastError === 'string' ? parsed.lastError : undefined,
    }
    return { loaded: this.data.schedule !== undefined }
  }

  /**
   * Whether a refresh is worth attempting.
   * @param {number} ttlMs
   * @returns {boolean}
   */
  due(ttlMs) {
    // Never attempted is always due: the interval measures how long ago the last
    // attempt was, and there has not been one.
    if (this.data.lastAttemptAt === 0) return true
    return this.now() - this.data.lastAttemptAt >= ttlMs
  }

  /**
   * Adopt a schedule and remember when it was read.
   * @param {object} schedule
   * @returns {Promise<void>}
   */
  async save(schedule) {
    const at = this.now()
    this.data = { schedule, fetchedAt: at, lastAttemptAt: at, lastError: undefined }
    await this.persist()
  }

  /**
   * Remember a failed attempt without touching the schedule in force.
   * @param {string} reason
   * @returns {Promise<void>}
   */
  async recordFailure(reason) {
    this.data = { ...this.data, lastAttemptAt: this.now(), lastError: String(reason) }
    await this.persist()
  }

  /** Serialize writes, so two refreshes cannot interleave into one file. */
  persist() {
    this.writes = this.writes.then(() => this.write(), () => this.write())
    return this.writes
  }

  /** Write the current state through a temporary file and rename it into place. */
  async write() {
    const payload = JSON.stringify({
      schemaVersion: LEARNED_PRICE_SCHEMA_VERSION,
      schedule: this.data.schedule,
      fetchedAt: this.data.fetchedAt,
      lastAttemptAt: this.data.lastAttemptAt,
      ...(this.data.lastError === undefined ? {} : { lastError: this.data.lastError }),
    }, null, 2)
    await mkdir(dirname(this.path), { recursive: true })
    this.sequence += 1
    const temporary = `${this.path}.tmp-${process.pid.toString(36)}-${this.sequence.toString(36)}`
    const handle = await openFile(temporary, 'w')
    try {
      await handle.writeFile(payload, 'utf8')
      await handle.sync()
    } finally {
      await handle.close()
    }
    await rename(temporary, this.path)
  }
}
