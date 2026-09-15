/**
 * Unified usage meter service.
 *
 * Owns the price book selection, the durable ledger, and the per-vendor account
 * readings — the DeepSeek balance and the Zhipu plan/balance/packages.
 * Everything the browser receives is built here as a small detached view model:
 * no credential, no raw fact, and no live DSH object crosses the wire.
 *
 * @module dsh-provider-openai-subscription/usage/service
 */

import { assertUsageFact, cacheHitRatio } from './types.js'
import { buildSchedules, quoteUsage, resolveSchedule, scheduleCovers, PUBLIC_SCHEDULES } from './pricing.js'
import { fetchDeepSeekBalance } from './deepseek-balance.js'
import { fetchZhipuAccount } from './zhipu-account.js'
import { ReadingSlot } from './reading-slot.js'
import { normalizeMeterConfig } from './config.js'
import { pricedVendors, vendorFor } from './vendors.js'

/** How long an account reading stays fresh. */
export const ACCOUNT_READING_TTL_MS = 5 * 60 * 1000

/** The registry id of the vendor whose reading is the Zhipu account. */
const ZHIPU_VENDOR_ID = 'zhipu'

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

/**
 * The Zhipu route this deployment serves. `zhipu-account.js` owns the station
 * map keyed by route, and a test asserts the two agree, so this literal cannot
 * drift away from the module that knows where the account lives.
 */
const ZHIPU_PROVIDER_ID = 'zai-coding-cn'

/** Meter service for the built-in usage UI. */
export class UsageMeterService {
  /**
   * @param {object} options
   * @param {object} options.ledger - an opened UsageLedger.
   * @param {unknown} [options.config] - raw settings section.
   * @param {() => number} [options.now]
   * @param {(url: string, init: object) => Promise<Response>} [options.fetchImpl]
   * @param {() => Promise<{baseURL: string|undefined, apiKey: string|undefined}>} [options.readDeepSeekCredential]
   * @param {() => Promise<{apiKey: string|undefined}>} [options.readZhipuCredential]
   * @param {number} [options.balanceTtlMs] - how long one account reading stays fresh.
   */
  constructor({ ledger, config, now = Date.now, fetchImpl = globalThis.fetch, readDeepSeekCredential, readZhipuCredential, balanceTtlMs = ACCOUNT_READING_TTL_MS }) {
    if (ledger === undefined || ledger === null) throw new TypeError('UsageMeterService requires a ledger')
    this.ledger = ledger
    this.config = normalizeMeterConfig(config)
    this.now = now
    this.fetchImpl = fetchImpl
    this.readDeepSeekCredential = readDeepSeekCredential
    this.readZhipuCredential = readZhipuCredential
    /** Bumped whenever the configuration changes, so stale async work is dropped. */
    this.generation = 0
    this.deepseek = new ReadingSlot({
      now: () => this.now(),
      ttlMs: balanceTtlMs,
      enabled: () => this.config.deepseekBalance !== false,
      generation: () => this.generation,
      hasReading: (reading) => Array.isArray(reading.infos) && reading.infos.length > 0,
      load: async () => {
        const credential = this.readDeepSeekCredential === undefined
          ? { apiKey: undefined }
          : await this.readDeepSeekCredential()
        // The balance is only ever read from the official host: a deployment that
        // routes model calls through a gateway still has a DeepSeek account, and
        // its key must not be sent to the gateway's own endpoint.
        return fetchDeepSeekBalance({
          baseURL: undefined,
          apiKey: credential.apiKey,
          fetchImpl: this.fetchImpl,
          now: this.now,
        })
      },
    })
    this.zhipu = new ReadingSlot({
      now: () => this.now(),
      ttlMs: balanceTtlMs,
      generation: () => this.generation,
      // Any one of the three readings is worth keeping: an account without a plan
      // still has packages, and an account without packages still has a balance.
      hasReading: (reading) => (Array.isArray(reading.packages) && reading.packages.length > 0)
        || reading.balance !== undefined
        || reading.plan?.applicable === true,
      load: async () => {
        const credential = this.readZhipuCredential === undefined
          ? { apiKey: undefined }
          : await this.readZhipuCredential()
        return fetchZhipuAccount({
          providerId: ZHIPU_PROVIDER_ID,
          apiKey: credential.apiKey,
          fetchImpl: this.fetchImpl,
          now: this.now,
        })
      },
    })
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
   * @param {boolean} [options.force] - read even when the cached reading is fresh.
   * @returns {Promise<object>} the current reading.
   */
  async refreshDeepSeekBalance({ force = false } = {}) {
    return this.deepseek.refresh({ force })
  }

  /**
   * Refresh the Zhipu account reading: plan windows when the account has a plan,
   * and otherwise its cash balance and resource packages.
   * @param {object} [options]
   * @param {boolean} [options.force] - read even when the cached reading is fresh.
   * @returns {Promise<object>} the current reading.
   */
  async refreshZhipuAccount({ force = false } = {}) {
    return this.zhipu.refresh({ force })
  }

  /**
   * The DeepSeek slice of the browser view model.
   * @returns {object}
   */
  balanceView() {
    const reading = this.deepseek.reading
    const hidden = this.config.hideBalance
    return {
      status: reading.status,
      available: reading.available === true,
      fetchedAt: reading.fetchedAt ?? 0,
      ...(hidden ? { infos: [], primary: undefined, hidden: true } : {
        infos: reading.infos ?? [],
        ...(reading.primary === undefined ? {} : { primary: reading.primary }),
      }),
      message: reading.message ?? '',
    }
  }

  /**
   * The Zhipu slice of the browser view model.
   *
   * `hideBalance` hides the cash amount only: a resource package states a token
   * count, and a token count is never private data.
   * @returns {object}
   */
  zhipuView() {
    const reading = this.zhipu.reading
    const hidden = this.config.hideBalance
    return {
      status: reading.status,
      fetchedAt: reading.fetchedAt ?? 0,
      ...(reading.plan === undefined ? {} : { plan: reading.plan }),
      ...(hidden || reading.balance === undefined ? {} : { balance: reading.balance }),
      packages: reading.packages ?? [],
      message: reading.message ?? '',
      ...(Array.isArray(reading.errors) && reading.errors.length > 0 ? { errors: reading.errors } : {}),
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
   * @param {string} [options.provider] - the route this read is about, so only that
   *   vendor's station is asked for a fresh reading.
   * @returns {object}
   */
  view({ sessionId, provider } = {}) {
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
    if (this.config.deepseekBalance && this.deepseek.due()) void this.refreshDeepSeekBalance()
    // The Zhipu station is only asked when this read is about a Zhipu route: a
    // DeepSeek-only deployment must not pay for a Zhipu request on every poll.
    if (vendorFor(provider)?.id === ZHIPU_VENDOR_ID && this.zhipu.due()) void this.refreshZhipuAccount()
    return {
      generatedAt: this.now(),
      account: { kind: this.config.accountKind, declared: this.config.accountKind !== 'unknown' },
      display: { currency: this.config.displayCurrency, timeZone: this.config.timeZone },
      privacy: { hideBalance: this.config.hideBalance, hideCost },
      deepseek: this.balanceView(),
      zhipu: this.zhipuView(),
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
        // The route is part of the read, not a filter the caller applies later:
        // the indicator follows the model the session runs, so another route's
        // tokens must not appear in these totals.
        session: aggregate(sessionId === undefined ? emptySummary : this.ledger.sessionSummary(sessionId, provider)),
        today: aggregate(this.ledger.summary('today', provider)),
        month: aggregate(this.ledger.summary('month', provider)),
      },
      hideCost,
    }
  }
}
