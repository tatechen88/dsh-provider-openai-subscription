/**
 * Plugin-owned settings for the usage meter.
 *
 * These settings belong to this plugin alone, so they live in the plugin's own
 * state directory rather than in a DSH registry namespace.  The file carries a
 * revision, and every write is atomic, so two browser tabs cannot silently
 * overwrite each other.
 *
 * @module dsh-provider-openai-subscription/usage/settings-store
 */

import { mkdir, open, readFile, rename } from 'node:fs/promises'
import { dirname } from 'node:path'
import { normalizeMeterConfig } from './config.js'

/** Settings file schema revision. */
export const METER_SETTINGS_SCHEMA_VERSION = 1

/** Raised when a write carries a stale revision. */
export class MeterSettingsConflictError extends Error {
  /**
   * @param {number} expected
   * @param {number} actual
   */
  constructor(expected, actual) {
    super(`meter settings moved from revision ${expected} to ${actual}`)
    this.name = 'MeterSettingsConflictError'
    this.code = 'settings-conflict'
    this.expectedRevision = expected
    this.actualRevision = actual
  }
}

/** File-backed meter settings. */
export class MeterSettingsStore {
  /**
   * @param {object} options
   * @param {string} options.path - absolute settings file path.
   * @param {unknown} [options.base] - composition-level defaults the file overrides.
   * @param {() => number} [options.now]
   */
  constructor({ path, base, now = Date.now }) {
    this.path = path
    this.base = base
    this.now = now
    /** Raw user layer, exactly as stored. */
    this.user = {}
    this.revision = 0
    /** Serializes writes, so two revisions cannot rename over each other. */
    this.writeChain = undefined
    /** Names temp files, so two writes in one millisecond cannot collide. */
    this.writeSequence = 0
    /** Schema version found on disk when this build cannot read it. */
    this.foreignVersion = undefined
  }

  /**
   * Load the stored user layer.
   * @returns {Promise<{revision: number}>}
   */
  async open() {
    try {
      const raw = await readFile(this.path, 'utf8')
      const parsed = JSON.parse(raw)
      if (parsed !== null && typeof parsed === 'object' && parsed.schemaVersion === METER_SETTINGS_SCHEMA_VERSION) {
        this.user = parsed.user !== null && typeof parsed.user === 'object' && !Array.isArray(parsed.user) ? parsed.user : {}
        this.revision = Number.isSafeInteger(parsed.revision) ? parsed.revision : 0
      } else if (parsed !== null && typeof parsed === 'object' && parsed.schemaVersion !== undefined) {
        // A newer build wrote this file. Reading it as empty and then writing
        // over it would discard the user's contract prices and privacy
        // switches, so it is left exactly as it is and every write is refused.
        this.foreignVersion = parsed.schemaVersion
        this.user = {}
        this.revision = 0
      }
    } catch (error) {
      if (error !== null && typeof error === 'object' && (error.code === 'ENOENT' || error instanceof SyntaxError)) {
        // An absent file is an unconfigured meter; a damaged one is treated the
        // same way here because the file holds display preferences only, never
        // billing facts, and the next write replaces it wholesale.
        this.user = {}
        this.revision = 0
      } else {
        throw error
      }
    }
    return { revision: this.revision }
  }

  /** The resolved configuration: file layer over the composition base. */
  resolved() {
    return normalizeMeterConfig({ ...(this.base ?? {}), ...(this.user) })
  }

  /**
   * The configuration as the settings panel edits it.
   *
   * Scalar fields take their effective values, but contract prices stay in the
   * units a user writes: {@link resolved} states them in micro units, and
   * showing those in the editor would invite the user to save 100000 for a
   * rate of 0.1.
   *
   * @returns {object}
   */
  editable() {
    const raw = this.raw()
    const contracts = Array.isArray(raw.contractualSchedules) ? raw.contractualSchedules : []
    return { ...this.resolved(), contractualSchedules: contracts }
  }

  /**
   * Replace the user layer.
   * @param {unknown} patch
   * @param {number} [expectedRevision]
   * @returns {Promise<{revision: number, config: object, raw: object}>}
   */
  async update(patch, expectedRevision) {
    if (Number.isSafeInteger(expectedRevision) && expectedRevision !== this.revision) {
      throw new MeterSettingsConflictError(expectedRevision, this.revision)
    }
    if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
      throw new TypeError('meter settings patch must be an object')
    }
    if (this.foreignVersion !== undefined) {
      const error = new Error(`meter settings on disk use schema v${String(this.foreignVersion)}; this build writes v${METER_SETTINGS_SCHEMA_VERSION} and leaves that file untouched`)
      error.code = 'settings-version'
      throw error
    }
    this.user = { ...this.user, ...patch }
    this.revision += 1
    await this.#enqueueWrite()
    return { revision: this.revision, config: this.resolved(), raw: this.raw() }
  }

  /**
   * The configuration as its layers state it, in the units a user writes.
   *
   * A caller that normalizes the configuration itself must take this rather
   * than {@link resolved}: resolution has already converted contract prices
   * from currency units into micro units, and normalizing that again would
   * multiply every rate by 10^6.
   *
   * @returns {object}
   */
  raw() {
    return { ...(this.base ?? {}), ...this.user }
  }

  /** Serialize writes so two revisions cannot rename over each other. */
  #enqueueWrite() {
    const next = (this.writeChain ?? Promise.resolve()).then(() => this.#write())
    // A failed write must not poison the chain for later ones.
    this.writeChain = next.catch(() => {})
    return next
  }

  /** Persist atomically. */
  async #write() {
    await mkdir(dirname(this.path), { recursive: true })
    const body = JSON.stringify({
      schemaVersion: METER_SETTINGS_SCHEMA_VERSION,
      revision: this.revision,
      updatedAt: this.now(),
      user: this.user,
    })
    this.writeSequence += 1
    const temp = `${this.path}.tmp-${process.pid}-${this.writeSequence}`
    const handle = await open(temp, 'w', 0o600)
    try {
      await handle.writeFile(`${body}\n`, { encoding: 'utf8' })
      // Without this a rename can reach the disk before the bytes do, and a
      // power loss leaves a truncated settings file where a valid one was.
      await handle.sync()
    } finally {
      await handle.close()
    }
    await rename(temp, this.path)
  }
}
