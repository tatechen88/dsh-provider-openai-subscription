/**
 * One cached account reading.
 *
 * Every account reading has the same lifecycle, and it is subtle enough to be
 * worth having exactly one implementation of:
 *
 * - a TTL, so a poll does not turn into a request storm;
 * - one request in flight at a time, so two callers share one upstream read;
 * - a timestamp taken when an attempt *starts*, so an endpoint that keeps failing
 *   is retried once per TTL instead of on every read;
 * - a generation guard, so a reading that a configuration change has already
 *   moved past is dropped instead of published;
 * - last-known-good retention, so a transient failure never blanks a number
 *   somebody is reading.
 *
 * The DeepSeek balance and the Zhipu account are two instances of this.
 *
 * @module dsh-provider-openai-subscription/usage/reading-slot
 */

/** Statuses that count as a settled reading, so a fresh one is reused. */
const SETTLED = Object.freeze(['ok', 'stale'])

export class ReadingSlot {
  /**
   * @param {object} options
   * @param {() => number} options.now - clock, shared with the owner.
   * @param {number} options.ttlMs - how long a reading stays fresh.
   * @param {() => Promise<object>} options.load - fetch one fresh reading body.
   * @param {(reading: object) => boolean} options.hasReading - whether the current
   *   reading is worth keeping when a later attempt fails.
   * @param {() => boolean} [options.enabled] - false reports `off` and loads nothing.
   * @param {() => number} [options.generation] - a change drops an in-flight result.
   * @param {object} [options.initial] - fields the reading starts with.
   */
  constructor({ now, ttlMs, load, hasReading, enabled, generation, initial }) {
    this.now = now
    this.ttlMs = ttlMs
    this.load = load
    this.hasReading = hasReading
    this.enabled = enabled
    this.generation = generation
    /** @type {object} */
    this.reading = { status: 'idle', fetchedAt: 0, message: '', ...initial }
    /** @type {Promise<object>|undefined} */
    this.inFlight = undefined
    /** When the last attempt started; the TTL is measured from here. */
    this.attemptAt = 0
  }

  /**
   * Whether a reading is due.
   *
   * Measured from the last attempt rather than the last success, so a failing
   * endpoint is retried once per TTL instead of on every read.
   * @returns {boolean}
   */
  due() {
    return this.now() - this.attemptAt >= this.ttlMs
  }

  /**
   * Read now, or return the cached reading.
   * @param {object} [options]
   * @param {boolean} [options.force] - read even when the cached reading is fresh.
   * @returns {Promise<object>} the reading after this call.
   */
  async refresh({ force = false } = {}) {
    if (this.enabled !== undefined && this.enabled() === false) {
      // The switch is off, and that is the state to report: showing a failure
      // would invite the user to retry something deliberately disabled.
      this.reading = { status: 'off', fetchedAt: 0, message: '' }
      return this.reading
    }
    const fresh = this.now() - this.reading.fetchedAt < this.ttlMs
    if (!force && SETTLED.includes(this.reading.status) && fresh) return this.reading
    if (this.inFlight !== undefined) return this.inFlight

    this.attemptAt = this.now()
    const generation = this.generation === undefined ? undefined : this.generation()
    const task = (async () => {
      try {
        const body = await this.load()
        if (generation !== undefined && generation !== this.generation()) return this.reading
        this.reading = {
          message: '',
          ...body,
          // A loader may report its own verdict (`no-data`, for instance); a
          // plain body means the read succeeded.
          status: typeof body?.status === 'string' ? body.status : 'ok',
          fetchedAt: typeof body?.fetchedAt === 'number' ? body.fetchedAt : this.now(),
        }
      } catch (error) {
        if (generation !== undefined && generation !== this.generation()) return this.reading
        const code = typeof /** @type {{code?: unknown}} */ (error)?.code === 'string'
          ? /** @type {{code: string}} */ (error).code
          : 'error'
        const message = error instanceof Error ? error.message : String(error)
        // A failed attempt keeps the last known good reading; only a reading that
        // never succeeded shows the failure as its primary state.
        this.reading = this.hasReading(this.reading)
          ? { ...this.reading, status: 'stale', message }
          : { status: code, fetchedAt: 0, message }
      }
      return this.reading
    })()
    this.inFlight = task
    try {
      return await task
    } finally {
      if (this.inFlight === task) this.inFlight = undefined
    }
  }
}
