/**
 * Balance service with in-memory cache, single-flight and stale fallback.
 *
 * @module dsh-provider-openai-subscription/balance/service
 */

/** Default cache TTL. */
export const DEFAULT_BALANCE_TTL_MS = 5 * 60 * 1000

/**
 * Balance service.
 */
export class BalanceService {
  /**
   * @param {object} options
   * @param {() => Promise<import('./types.js').BalanceSnapshot>} options.fetch
   * @param {number} [options.ttlMs]
   * @param {() => number} [options.now]
   */
  constructor({ fetch, ttlMs = DEFAULT_BALANCE_TTL_MS, now = Date.now }) {
    if (typeof fetch !== 'function') throw new TypeError('BalanceService requires fetch')
    this.fetch = fetch
    this.ttlMs = ttlMs
    this.now = now
    /** @type {import('./types.js').BalanceSnapshot|undefined} */
    this.cache = undefined
    this.cachedAt = 0
    /** @type {Promise<import('./types.js').BalanceSnapshot>|undefined} */
    this.flight = undefined
    this.timer = undefined
  }

  /**
   * Return the current snapshot, refreshing when stale or forced.
   * @param {boolean} [force]
   * @returns {Promise<import('./types.js').BalanceSnapshot>}
   */
  async get(force = false) {
    const now = this.now()
    if (!force && this.cache !== undefined && now - this.cachedAt < this.ttlMs) {
      return this.cache
    }
    if (this.flight === undefined) {
      this.flight = this.#refresh(now).finally(() => {
        this.flight = undefined
      })
    }
    return this.flight
  }

  /**
   * Clear the cache (used on logout/account change).
   */
  clear() {
    this.cache = undefined
    this.cachedAt = 0
  }

  /**
   * Start automatic polling.
   * @param {number} [intervalMs]
   * @returns {() => void}
   */
  startPolling(intervalMs = this.ttlMs) {
    if (this.timer !== undefined) clearInterval(this.timer)
    this.timer = setInterval(() => {
      void this.get(true).catch(() => {})
    }, intervalMs)
    this.timer.unref?.()
    return () => {
      if (this.timer !== undefined) {
        clearInterval(this.timer)
        this.timer = undefined
      }
    }
  }

  /**
   * One actual fetch, storing cache on success and stale fallback on failure.
   * @param {number} startedAt
   * @returns {Promise<import('./types.js').BalanceSnapshot>}
   */
  async #refresh(startedAt) {
    try {
      const snapshot = await this.fetch()
      this.cache = snapshot
      this.cachedAt = startedAt
      return snapshot
    } catch (error) {
      const code = /** @type {{code?: string}} */ (error).code ?? 'unknown'
      const message = error instanceof Error ? error.message : String(error)
      if (this.cache !== undefined) {
        const stale = { ...this.cache, status: 'stale', fetchedAt: this.cache.fetchedAt ?? this.cachedAt, errorCode: code, message }
        return stale
      }
      const failed = {
        status: 'error',
        windows: [],
        additionalLimits: [],
        fetchedAt: startedAt,
        errorCode: code,
        message,
      }
      this.cache = failed
      this.cachedAt = startedAt
      return failed
    }
  }
}
