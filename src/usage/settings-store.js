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

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
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
    return normalizeMeterConfig({ ...(this.base ?? {}), ...this.user })
  }

  /**
   * Replace the user layer.
   * @param {unknown} patch
   * @param {number} [expectedRevision]
   * @returns {Promise<{revision: number, config: object}>}
   */
  async update(patch, expectedRevision) {
    if (Number.isSafeInteger(expectedRevision) && expectedRevision !== this.revision) {
      throw new MeterSettingsConflictError(expectedRevision, this.revision)
    }
    if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
      throw new TypeError('meter settings patch must be an object')
    }
    this.user = { ...this.user, ...patch }
    this.revision += 1
    await this.#write()
    return { revision: this.revision, config: this.resolved() }
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
    const temp = `${this.path}.tmp-${process.pid}-${this.now()}`
    await writeFile(temp, `${body}\n`, { encoding: 'utf8', mode: 0o600 })
    await rename(temp, this.path)
  }
}
