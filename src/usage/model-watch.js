/**
 * Model-catalog watch across the vendors this deployment uses.
 *
 * Each vendor publishes a model directory, and a new model appears there before
 * this plugin could ever know its name. One scan per vendor diffs the directory
 * against the names seen before and keeps the difference: the card names a new
 * model instead of the user noticing it weeks later in an unpriced line.
 *
 * The stored file is a cache, not a preference, in the same sense as the
 * learned price table: it lives beside the ledger, an unreadable file is
 * ignored, and deleting it only means every current model becomes the new
 * baseline on the next scan.
 *
 * The OpenAI subscription catalog is not fetched here: the adapter already
 * owns that authenticated request, so its list arrives as an injected function
 * and this module never reimplements it.
 *
 * @module dsh-provider-openai-subscription/usage/model-watch
 */

import { mkdir, open as openFile, readFile, rename } from 'node:fs/promises'
import { dirname } from 'node:path'
import { authorizationFor } from './zhipu-account.js'

/** Version of the stored file. A file from another version is ignored. */
export const MODEL_WATCH_SCHEMA_VERSION = 1

/** How long one scan's result stands before the directories are read again. */
export const MODEL_WATCH_TTL_MS = 30 * 60 * 1000

/**
 * The official directory endpoint per vendor, keyed by vendor id (the same ids
 * the vendor registry uses). A vendor without an entry here has no watchable
 * directory: the OpenAI subscription catalog arrives through injection instead.
 */
export const MODEL_WATCH_SOURCES = Object.freeze({
  deepseek: Object.freeze({
    provider: 'deepseek-official',
    url: 'https://api.deepseek.com/models',
    /** DeepSeek's directory authenticates like every other official endpoint. */
    credential: 'deepseek',
  }),
  zhipu: Object.freeze({
    provider: 'zai-coding-cn',
    url: 'https://open.bigmodel.cn/api/paas/v4/models',
    credential: 'zhipu',
  }),
})

/** Default request bound, in milliseconds, covering the body read as well. */
export const MODEL_WATCH_TIMEOUT_MS = 15_000

/**
 * Extract the model ids from one directory response.
 *
 * The three stations answer in different but related shapes — an OpenAI-style
 * `data` array, a wrapped `data.items` object, or a bare array — and a tolerant
 * reader costs less than one branch per vendor that can silently rot. Anything
 * without recognizable ids is a refusal to guess, never an empty catalog: an
 * empty answer would erase the baseline and flag every model as new.
 * @param {unknown} body
 * @returns {{ok: boolean, ids?: string[], reason?: string}}
 */
export function extractModelIds(body) {
  const refused = body !== null && typeof body === 'object'
    && (/** @type {Record<string, unknown>} */ (body).success === false)
  if (refused) return { ok: false, reason: 'the station refused the request' }
  const rows = collectRows(body)
  const ids = []
  for (const row of rows) {
    const id = typeof row === 'string' ? row : row !== null && typeof row === 'object' ? (/** @type {Record<string, unknown>} */ (row)).id : undefined
    if (typeof id === 'string' && id.trim().length > 0) ids.push(id.trim())
  }
  if (ids.length === 0) return { ok: false, reason: 'the directory carries no model ids' }
  return { ok: true, ids: [...new Set(ids)] }
}

/**
 * Gather the candidate rows of one directory response.
 * @param {unknown} body
 * @returns {unknown[]}
 */
function collectRows(body) {
  if (Array.isArray(body)) return body
  if (body === null || typeof body !== 'object') return []
  const record = /** @type {Record<string, unknown>} */ (body)
  for (const key of ['data', 'models', 'items']) {
    const value = record[key]
    if (Array.isArray(value)) return value
    if (value !== null && typeof value === 'object' && Array.isArray(/** @type {Record<string, unknown>} */ (value).items)) {
      return /** @type {Record<string, unknown>} */ (value).items
    }
  }
  return []
}

/**
 * The ids of one directory that the stored baseline does not carry yet.
 * @param {Record<string, number>} known - model id to the instant it was first seen.
 * @param {string[]} current
 * @returns {string[]}
 */
export function newModelIds(known, current) {
  return current.filter((id) => !Object.prototype.hasOwnProperty.call(known, id))
}

/**
 * The state of one vendor, or its empty shape.
 * @param {object|undefined} entry
 * @returns {{known: Record<string, number>, acknowledgedAt: number, scannedAt: number, lastError: string|undefined}}
 */
function entryOrEmpty(entry) {
  if (entry === null || typeof entry !== 'object') {
    return { known: {}, acknowledgedAt: 0, scannedAt: 0, lastError: undefined }
  }
  const record = /** @type {Record<string, unknown>} */ (entry)
  /** @type {Record<string, number>} */
  const known = {}
  if (record.known !== null && typeof record.known === 'object') {
    for (const [id, at] of Object.entries(/** @type {Record<string, unknown>} */ (record.known))) {
      if (typeof id === 'string' && typeof at === 'number' && Number.isFinite(at)) known[id] = at
    }
  }
  return {
    known,
    acknowledgedAt: typeof record.acknowledgedAt === 'number' ? record.acknowledgedAt : 0,
    scannedAt: typeof record.scannedAt === 'number' ? record.scannedAt : 0,
    lastError: typeof record.lastError === 'string' ? record.lastError : undefined,
  }
}

/** Baseline store for the model watch. */
export class ModelWatchStore {
  /**
   * @param {object} options
   * @param {string} options.path - absolute file path.
   * @param {() => number} [options.now]
   */
  constructor({ path, now = Date.now }) {
    this.path = path
    this.now = now
    /** @type {{vendors: Record<string, object>}} */
    this.data = { vendors: {} }
    this.writes = Promise.resolve()
    this.sequence = 0
  }

  /**
   * Read what is on disk. A file that cannot be read is reported and then
   * ignored: a broken cache must never stop a scan.
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
    if (parsed === null || typeof parsed !== 'object' || parsed.schemaVersion !== MODEL_WATCH_SCHEMA_VERSION) {
      return { loaded: false, reason: 'unsupported-schema' }
    }
    const vendors = /** @type {Record<string, unknown>} */ (parsed.vendors ?? {})
    /** @type {Record<string, object>} */
    const restored = {}
    for (const [id, entry] of Object.entries(vendors)) {
      if (typeof id === 'string') restored[id] = entryOrEmpty(entry)
    }
    this.data = { vendors: restored }
    return { loaded: true }
  }

  /**
   * One vendor's stored state.
   * @param {string} vendorId
   * @returns {{known: Record<string, number>, acknowledgedAt: number, scannedAt: number, lastError: string|undefined}}
   */
  vendor(vendorId) {
    return entryOrEmpty(this.data.vendors[vendorId])
  }

  /**
   * Replace one vendor's state and persist.
   * @param {string} vendorId
   * @param {{known?: Record<string, number>, acknowledgedAt?: number, scannedAt?: number, lastError?: string|undefined}} patch
   * @returns {Promise<void>}
   */
  async saveVendor(vendorId, patch) {
    const current = this.vendor(vendorId)
    this.data.vendors[vendorId] = {
      known: patch.known ?? current.known,
      acknowledgedAt: patch.acknowledgedAt ?? current.acknowledgedAt,
      scannedAt: patch.scannedAt ?? current.scannedAt,
      lastError: patch.lastError !== undefined ? patch.lastError : undefined,
    }
    await this.persist()
  }

  /** Serialize writes, so two scans cannot interleave into one file. */
  persist() {
    this.writes = this.writes.then(() => this.write(), () => this.write())
    return this.writes
  }

  /** Write the current state through a temporary file and rename it into place. */
  async write() {
    const payload = JSON.stringify({ schemaVersion: MODEL_WATCH_SCHEMA_VERSION, vendors: this.data.vendors }, null, 2)
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

/** Watch service: scan the vendor directories, diff, and report. */
export class ModelWatchService {
  /**
   * @param {object} options
   * @param {object} options.store - an opened ModelWatchStore.
   * @param {(url: string, init: object) => Promise<Response>} [options.fetchImpl]
   * @param {() => Promise<{apiKey: string|undefined}>} [options.readDeepSeekCredential]
   * @param {() => Promise<{apiKey: string|undefined}>} [options.readZhipuCredential]
   * @param {() => Promise<Array<{id: string, name?: string}>>} [options.listOpenAIModels] -
   *   the subscription adapter's catalog, injected so this module never
   *   reimplements an authenticated request it does not own.
   * @param {() => number} [options.now]
   * @param {number} [options.ttlMs]
   * @param {number} [options.timeoutMs]
   */
  constructor({ store, fetchImpl = globalThis.fetch, readDeepSeekCredential, readZhipuCredential, listOpenAIModels, now = Date.now, ttlMs = MODEL_WATCH_TTL_MS, timeoutMs = MODEL_WATCH_TIMEOUT_MS }) {
    this.store = store
    this.fetchImpl = fetchImpl
    this.readDeepSeekCredential = readDeepSeekCredential
    this.readZhipuCredential = readZhipuCredential
    this.listOpenAIModels = listOpenAIModels
    this.now = now
    this.ttlMs = ttlMs
    this.timeoutMs = timeoutMs
    /** The in-flight scan, so concurrent misses share one round of requests. */
    this.scan_ = undefined
  }

  /** The vendor ids this deployment can actually watch. */
  #watched() {
    const ids = Object.keys(MODEL_WATCH_SOURCES)
    if (this.listOpenAIModels !== undefined) ids.push('openai-subscription')
    return ids
  }

  /**
   * Whether a scan is worth attempting.
   *
   * The comparison runs on this service's clock, not the store's: the store is
   * a file cache, and a test or deployment that injects a clock must get due
   * answers on that clock.
   * @returns {boolean}
   */
  due() {
    return this.#watched().some((vendorId) => {
      const scannedAt = this.store.vendor(vendorId).scannedAt
      // Never scanned is always due: the interval measures the last attempt.
      return scannedAt === 0 || this.now() - scannedAt >= this.ttlMs
    })
  }

  /**
   * Read every watched directory and fold the result into the baseline.
   *
   * A vendor's first scan becomes the baseline itself: everything current is
   * acknowledged at once, because flagging the whole existing catalog as new
   * would make the first look useless. One vendor failing never blocks the
   * others, and a failure keeps the previous baseline instead of erasing it.
   * @param {object} [options]
   * @param {boolean} [options.force]
   * @returns {Promise<object>} the view after the scan.
   */
  async scan({ force = false } = {}) {
    if (!force && !this.due()) return this.view()
    if (this.scan_ !== undefined) return this.scan_
    const work = (async () => {
      const at = this.now()
      await Promise.all([
        this.#scanHttp('deepseek', MODEL_WATCH_SOURCES.deepseek, this.readDeepSeekCredential, at),
        this.#scanHttp('zhipu', MODEL_WATCH_SOURCES.zhipu, this.readZhipuCredential, at),
        this.#scanInjected(at),
      ])
      return this.view()
    })().finally(() => {
      this.scan_ = undefined
    })
    this.scan_ = work
    return work
  }

  /**
   * Scan one HTTP directory.
   * @param {string} vendorId
   * @param {{url: string, credential: string}} source
   * @param {(() => Promise<{apiKey: string|undefined}>)|undefined} readCredential
   * @param {number} at
   * @returns {Promise<void>}
   */
  async #scanHttp(vendorId, source, readCredential, at) {
    const credential = readCredential === undefined ? { apiKey: undefined } : await readCredential().catch(() => ({ apiKey: undefined }))
    if (typeof credential.apiKey !== 'string' || credential.apiKey.length === 0) {
      // No key is an account fact, not a scan failure: the vendor simply has
      // nothing watchable from this deployment.
      await this.store.saveVendor(vendorId, { scannedAt: at, lastError: undefined }).catch(() => {})
      return
    }
    let body
    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), this.timeoutMs)
      timer.unref?.()
      try {
        const response = await this.fetchImpl(source.url, {
          method: 'GET',
          headers: { authorization: authorizationFor(new URL(source.url).host, credential.apiKey), accept: 'application/json' },
          signal: controller.signal,
          redirect: 'error',
        })
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        body = await response.json()
      } finally {
        clearTimeout(timer)
      }
    } catch (error) {
      await this.store.saveVendor(vendorId, { scannedAt: at, lastError: error instanceof Error ? error.message : String(error) }).catch(() => {})
      return
    }
    await this.#adopt(vendorId, extractModelIds(body), at)
  }

  /**
   * Scan the injected OpenAI subscription catalog.
   * @param {number} at
   * @returns {Promise<void>}
   */
  async #scanInjected(at) {
    if (this.listOpenAIModels === undefined) return
    try {
      const models = await this.listOpenAIModels()
      await this.#adopt('openai-subscription', extractModelIds(models), at)
    } catch (error) {
      await this.store.saveVendor('openai-subscription', { scannedAt: at, lastError: error instanceof Error ? error.message : String(error) }).catch(() => {})
    }
  }

  /**
   * Fold one parsed directory into the baseline.
   * @param {string} vendorId
   * @param {{ok: boolean, ids?: string[], reason?: string}} parsed
   * @param {number} at
   * @returns {Promise<void>}
   */
  async #adopt(vendorId, parsed, at) {
    const entry = this.store.vendor(vendorId)
    const first = entry.scannedAt === 0
    if (parsed.ok !== true) {
      // A directory that cannot be read keeps the baseline it had: a scan
      // failure must never present every model as brand new afterwards.
      await this.store.saveVendor(vendorId, { scannedAt: at, lastError: parsed.reason }).catch(() => {})
      return
    }
    /** @type {Record<string, number>} */
    const known = { ...entry.known }
    for (const id of parsed.ids ?? []) {
      if (!Object.prototype.hasOwnProperty.call(known, id)) known[id] = at
    }
    await this.store.saveVendor(vendorId, {
      known,
      scannedAt: at,
      // The first scan is its own baseline: nothing on it is "new".
      acknowledgedAt: first ? at : entry.acknowledgedAt,
      lastError: undefined,
    }).catch(() => {})
  }

  /**
   * Wait for the watch to be quiet: the in-flight scan first, then every write.
   *
   * A teardown that must leave no residue awaits this. Waiting for the write
   * chain alone is not enough: a scan still reading a directory has not queued
   * its write yet, so that write — and the temporary file it creates — would
   * start after the disposer that owns it had already returned. The scan is
   * bounded by its own request timeout, and it settles the same way whether it
   * succeeded or failed.
   * @returns {Promise<void>}
   */
  async settle() {
    await this.scan_?.catch(() => {})
    await this.store.writes.catch(() => {})
  }

  /**
   * The browser-facing view: per vendor, what is known and what is new.
   * @returns {object}
   */
  view() {
    const vendors = this.#watched().map((vendorId) => {
      const entry = this.store.vendor(vendorId)
      const total = Object.keys(entry.known).length
      const news = Object.entries(entry.known)
        .filter(([, firstSeenAt]) => firstSeenAt > entry.acknowledgedAt)
        .sort((left, right) => right[1] - left[1])
        .map(([id, firstSeenAt]) => ({ id, firstSeenAt }))
      return {
        vendor: vendorId,
        status: entry.scannedAt === 0 ? 'never' : entry.lastError !== undefined ? 'error' : 'ok',
        total,
        newModels: news,
        scannedAt: entry.scannedAt,
        ...(entry.lastError === undefined ? {} : { lastError: entry.lastError }),
      }
    })
    return { generatedAt: this.now(), vendors }
  }

  /**
   * Fold everything currently known into the baseline, clearing the "new" marks.
   * @returns {Promise<object>} the view after acknowledging.
   */
  async acknowledge() {
    const at = this.now()
    for (const vendorId of this.#watched()) {
      if (this.store.vendor(vendorId).scannedAt === 0) continue
      await this.store.saveVendor(vendorId, { acknowledgedAt: at }).catch(() => {})
    }
    return this.view()
  }
}
