/**
 * Unified usage meter service.
 *
 * Owns the price book selection, the durable ledger, and the DeepSeek account
 * snapshot.  Everything the browser receives is built here as a small detached
 * view model: no credential, no raw fact, and no live DSH object crosses the
 * wire.
 *
 * @module dsh-provider-openai-subscription/usage/service
 */

import { assertUsageFact, cacheHitRatio } from './types.js'
import { buildSchedules, quoteUsage, resolveSchedule, scheduleCovers, PUBLIC_SCHEDULES } from './pricing.js'
import { fetchDeepSeekBalance, DeepSeekBalanceError } from './deepseek-balance.js'
import { normalizeMeterConfig } from './config.js'
import { pricedVendors } from './vendors.js'

/** How long a DeepSeek balance reading stays fresh. */
export const DEEPSEEK_BALANCE_TTL_MS = 5 * 60 * 1000

/**
 * Build the browser-facing view of one aggregate.
 *
 * The displayed amount is the configured currency when the account spent in it.
 * When it did not — an enterprise agreement billed in USD while the display
 * currency is CNY, say — the sole currency actually spent is shown as itself.
 * Amounts are never converted: an invented exchange rate would be a number
 * nobody billed.
 * @param {object} summary
 * @param {object} config
 * @returns {object}
 */
function viewOfAggregate(summary, config) {
  const byCurrency = summary.amountMicrosByCurrency ?? {}
  const currencies = Object.keys(byCurrency)
  const chosen = byCurrency[config.displayCurrency] !== undefined
    ? config.displayCurrency
    : currencies.length === 1 ? currencies[0] : undefined
  return {
    calls: summary.calls,
    usage: summary.usage,
    cacheHitRatio: cacheHitRatio(summary.usage),
    amountsMicrosByCurrency: byCurrency,
    ...(chosen === undefined ? {} : { amountMicros: byCurrency[chosen], amountCurrency: chosen }),
  }
}

/** Meter service for the built-in usage UI. */
export class UsageMeterService {
  /**
   * @param {object} options
   * @param {object} options.ledger - an opened UsageLedger.
   * @param {unknown} [options.config] - raw settings section.
   * @param {() => number} [options.now]
   * @param {(url: string, init: object) => Promise<Response>} [options.fetchImpl]
   * @param {() => Promise<{baseURL: string|undefined, apiKey: string|undefined}>} [options.readDeepSeekCredential]
   * @param {number} [options.balanceTtlMs]
   */
  constructor({ ledger, config, now = Date.now, fetchImpl = globalThis.fetch, readDeepSeekCredential, balanceTtlMs = DEEPSEEK_BALANCE_TTL_MS }) {
    if (ledger === undefined || ledger === null) throw new TypeError('UsageMeterService requires a ledger')
    this.ledger = ledger
    this.config = normalizeMeterConfig(config)
    this.now = now
    this.fetchImpl = fetchImpl
    this.readDeepSeekCredential = readDeepSeekCredential
    this.balanceTtlMs = balanceTtlMs
    /** @type {object} */
    this.balance = { status: 'idle', infos: [], fetchedAt: 0, message: '' }
    /** @type {Promise<object>|undefined} */
    this.balanceInFlight = undefined
    /** When the last attempt started, so a failing endpoint is not retried per read. */
    this.balanceAttemptAt = 0
    /** Bumped whenever the configuration changes, so stale async work is dropped. */
    this.generation = 0
  }

  /**
   * Replace the meter configuration.
   *
   * The argument is the configuration as its layers state it, with contract
   * prices still in currency units, because this is the one place that
   * normalizes them. Handing over an already resolved configuration would
   * convert those prices a second time and multiply every rate by 10^6.
   *
   * @param {unknown} raw
   * @returns {object} the resolved configuration.
   */
  updateConfig(raw) {
    this.config = normalizeMeterConfig(raw)
    // "Today" and "month" are calendar windows, so the ledger follows a
    // time-zone change at once instead of at the next start.
    this.ledger.timeZone = this.config.timeZone
    this.generation += 1
    return this.config
  }

  /**
   * The public price tables this deployment offers: one per vendor that
   * publishes a table. The registry names them by id, so this module joins an id
   * to a table instead of importing a snapshot it may not use.
   * @returns {object[]}
   */
  publicSchedules() {
    return pricedVendors()
      .map((vendor) => PUBLIC_SCHEDULES[vendor.priceTableId])
      .filter((schedule) => schedule !== undefined)
  }

  /** The schedules currently reachable by the resolver. */
  schedules() {
    return buildSchedules({ contractual: this.config.contractualSchedules, schedules: this.publicSchedules() })
  }

  /**
   * Meter one model call: validate, price, and persist it.
   * @param {object} rawFact
   * @returns {{ok: boolean, reason?: string, quote?: object}}
   */
  recordUsage(rawFact) {
    try {
      const fact = assertUsageFact(rawFact)
      const schedule = resolveSchedule({
        provider: fact.provider,
        model: fact.model,
        at: fact.startedAt,
        accountKind: this.config.accountKind,
        schedules: this.schedules(),
      })
      const quote = quoteUsage(fact, schedule)
      const stored = this.ledger.record(fact, quote)
      return { ok: true, stored, quote }
    } catch (error) {
      // Metering must never fail the model call it observes.
      return { ok: false, reason: error instanceof Error ? error.message : String(error) }
    }
  }

  /**
   * Refresh the DeepSeek balance reading.
   * @param {object} [options]
   * @param {boolean} [options.force]
   * @returns {Promise<object>} the current balance view.
   */
  async refreshDeepSeekBalance({ force = false } = {}) {
    if (!this.config.deepseekBalance) {
      // The outbound request is switched off, and that is the state to report:
      // showing a failure would invite the user to retry a disabled feature.
      this.balance = { status: 'off', infos: [], fetchedAt: 0, message: '' }
      return this.balance
    }
    const fresh = this.now() - this.balance.fetchedAt < this.balanceTtlMs
    if (!force && (this.balance.status === 'ok' || this.balance.status === 'stale') && fresh) return this.balance
    if (this.balanceInFlight !== undefined) return this.balanceInFlight
    this.balanceAttemptAt = this.now()

    const generation = this.generation
    const task = (async () => {
      try {
        const credential = this.readDeepSeekCredential === undefined
          ? { apiKey: undefined }
          : await this.readDeepSeekCredential()
        // The balance is only ever read from the official host: a deployment
        // that routes model calls through a gateway still has a DeepSeek
        // account, and its key must not be sent to the gateway's own endpoint.
        const snapshot = await fetchDeepSeekBalance({
          baseURL: undefined,
          apiKey: credential.apiKey,
          fetchImpl: this.fetchImpl,
          now: this.now,
        })
        if (generation !== this.generation) return this.balance
        this.balance = { status: 'ok', message: '', ...snapshot }
      } catch (error) {
        if (generation !== this.generation) return this.balance
        const code = error instanceof DeepSeekBalanceError ? error.code : 'error'
        const message = error instanceof Error ? error.message : String(error)
        // A failed refresh keeps the last known good reading; only a reading
        // that never succeeded shows the failure as the primary state.
        this.balance = this.balance.infos.length > 0
          ? { ...this.balance, status: 'stale', message }
          : { status: code, infos: [], fetchedAt: 0, message }
      }
      return this.balance
    })()
    this.balanceInFlight = task
    try {
      return await task
    } finally {
      if (this.balanceInFlight === task) this.balanceInFlight = undefined
    }
  }

  /**
   * Whether a balance reading is due.
   *
   * Measured from the last attempt rather than the last success, so a failing
   * endpoint is retried once per TTL instead of on every read.
   * @returns {boolean}
   */
  balanceDue() {
    return this.now() - this.balanceAttemptAt >= this.balanceTtlMs
  }

  /**
   * The DeepSeek slice of the browser view model.
   * @returns {object}
   */
  balanceView() {
    const hidden = this.config.hideBalance
    return {
      status: this.balance.status,
      available: this.balance.available === true,
      fetchedAt: this.balance.fetchedAt ?? 0,
      ...(hidden ? { infos: [], primary: undefined, hidden: true } : {
        infos: this.balance.infos ?? [],
        ...(this.balance.primary === undefined ? {} : { primary: this.balance.primary }),
      }),
      message: this.balance.message ?? '',
    }
  }

  /**
   * Which price table is actually in force right now.
   *
   * A configured agreement is only "active" when it is in force AND the account
   * has been declared enterprise, because that is exactly the condition
   * {@link resolveSchedule} applies. Reporting it any other way would tell the
   * user a contract price they are not being billed at.
   * @returns {object}
   */
  contractualStatus() {
    const contracts = this.config.contractualSchedules
    if (contracts.length === 0) return { configured: false, active: false }
    const now = this.now()
    const covered = contracts.find((schedule) => scheduleCovers(schedule, now))
    const active = this.config.accountKind === 'enterprise' ? covered : undefined
    return {
      configured: true,
      active: active !== undefined,
      ...(covered === undefined ? {} : {
        label: covered.label,
        currency: covered.currency,
        ...(covered.validTo === undefined ? {} : { validTo: covered.validTo }),
      }),
      ...(active === undefined ? {} : { scheduleId: active.id }),
    }
  }

  /**
   * Build the browser view model.
   *
   * Tokens always survive: privacy hides money and balance, never the token
   * accounting a user needs to reason about context.
   * @param {object} [options]
   * @param {string} [options.sessionId]
   * @returns {object}
   */
  view({ sessionId } = {}) {
    const hideCost = this.config.hideCost
    // One deployment offers one priced public table today. Reading it from the
    // registry rather than importing the snapshot keeps the wire shape stable
    // while a second priced vendor becomes a list entry instead of an import.
    const publicPrice = this.publicSchedules()[0]
    const emptySummary = { calls: 0, usage: { inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0, reasoningTokens: 0, promptTokens: 0 }, amountsMicrosByCurrency: {} }
    const aggregate = (summary) => {
      const base = viewOfAggregate(summary, this.config)
      if (!hideCost) return base
      // The billed currency goes with the amounts: naming it still says which
      // money the account is spending.
      const { amountsMicrosByCurrency, amountMicros, amountCurrency, ...tokensOnly } = base
      return tokensOnly
    }
    // A read that finds no balance reading asks for one without waiting for it:
    // the sidebar polls this route, so the next poll shows the balance instead
    // of the reading waiting for somebody to press refresh.
    if (this.config.deepseekBalance && this.balanceDue()) void this.refreshDeepSeekBalance()
    return {
      generatedAt: this.now(),
      account: { kind: this.config.accountKind, declared: this.config.accountKind !== 'unknown' },
      display: { currency: this.config.displayCurrency, timeZone: this.config.timeZone },
      privacy: { hideBalance: this.config.hideBalance, hideCost },
      deepseek: this.balanceView(),
      pricing: {
        public: {
          scheduleId: publicPrice?.id,
          currency: publicPrice?.currency,
          retrievedAt: publicPrice?.retrievedAt,
          sourceUrl: publicPrice?.sourceUrl,
        },
        contractual: this.contractualStatus(),
        estimated: true,
        basis: 'request-start-assumption',
      },
      usage: {
        session: aggregate(sessionId === undefined ? emptySummary : this.ledger.sessionSummary(sessionId)),
        today: aggregate(this.ledger.summary('today')),
        month: aggregate(this.ledger.summary('month')),
      },
      hideCost,
    }
  }
}
