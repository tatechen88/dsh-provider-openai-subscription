/**
 * What this plugin can be asked to do, independent of who asks.
 *
 * With no browser half there is no page to click, so every operation needs an
 * entry that a *host* provides: an agent tool, a CLI, or the authorization seam.
 * They all describe the same few actions, and this module is the one place those
 * actions are implemented — a second implementation is how two surfaces start
 * disagreeing about what "signed in" means.
 *
 * Nothing here prompts. A tool call cannot ask a follow-up question, so an
 * operation either finishes or reports what is still pending; the surface that
 * can ask (the seam's `manual` method) does its asking in the flow.
 *
 * @module dsh-provider-openai-subscription/operations
 */

import { PROVIDER_ID } from './constants.js'

/** How long a tool waits for a human to finish a login before reporting it pending. */
export const DEFAULT_LOGIN_WAIT_MS = 60_000

/**
 * @param {number} ms
 * @returns {Promise<'timeout'>}
 */
function delay(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve('timeout'), ms)
    timer.unref?.()
  })
}

/**
 * Build the operations over one activation's live services.
 *
 * @param {object} input
 * @param {object} input.repository - credential repository.
 * @param {object} input.attempts - loopback attempt manager.
 * @param {object} input.devices - device-code attempt manager.
 * @param {object} [input.balance] - balance service, cleared on sign-out.
 * @param {object} [input.authorization] - the `authorization` service, when mounted.
 * @param {string} input.authorizationKey - credential key the flow is registered under.
 * @param {object} [input.config] - normalized plugin config.
 * @param {object} [input.meter] - the usage meter's parts (`service`, `openaiQuota`, …).
 * @param {() => Promise<object>} [input.legacy] - reports what the previous plugin family left behind.
 * @param {number} [input.loginWaitMs] - bounded wait for one login call.
 * @param {(ms: number) => Promise<'timeout'>} [input.sleep] - test seam.
 * @returns {object} the operations.
 */
export function createOperations({
  repository,
  attempts,
  devices,
  balance,
  authorization,
  authorizationKey,
  config,
  meter,
  legacy,
  loginWaitMs = DEFAULT_LOGIN_WAIT_MS,
  sleep = delay,
}) {
  /**
   * The attempt a surface would resume: the newest one that has not settled.
   * @returns {object|undefined}
   */
  const pendingAttempt = () => {
    const candidates = [attempts?.pending?.(), devices?.pending?.()].filter((entry) => entry !== undefined)
    return candidates[0]
  }

  const loginState = () => {
    const attempt = pendingAttempt()
    const described = typeof authorization?.describe === 'function' ? authorization.describe(authorizationKey) : undefined
    return {
      inFlight: described?.inFlight === true,
      ...(attempt === undefined ? {} : { attempt: attempt.toJSON() }),
    }
  }

  return {
    /**
     * Everything a caller needs to know about the credential and the route.
     * @returns {Promise<object>}
     */
    async status() {
      const credential = await repository.status()
      const provider = config?.provider ?? {}
      return {
        provider: PROVIDER_ID,
        credential,
        configured: credential.configured === true,
        provider_defaults: {
          defaultModel: provider.defaultModel ?? '',
          reasoningEffort: provider.reasoningEffort ?? '',
        },
        login: loginState(),
        ...(typeof legacy !== 'function' ? {} : { legacy: await legacy().catch(() => undefined) }),
      }
    },

    /**
     * Begin — or resume — a sign-in, waiting only as long as the caller allows.
     *
     * A caller that stops waiting does not cancel anything: the attempt keeps
     * running, so a human who opens the link a minute later still finishes the
     * login, and the next `status` reports it. Cancelling is a separate, explicit
     * action (`cancelLogin`), because "I stopped listening" and "I changed my
     * mind" are different statements.
     *
     * @param {object} [options]
     * @param {string} [options.method] - one of the flow's method ids.
     * @param {number} [options.waitMs] - how long to wait before reporting pending.
     * @returns {Promise<object>}
     */
    async login({ method, waitMs } = {}) {
      if (authorization === undefined || typeof authorization.begin !== 'function') {
        return { status: 'unavailable', reason: 'no authorization service is mounted in this deployment' }
      }
      if (authorization.describe?.(authorizationKey)?.inFlight === true) {
        const attempt = pendingAttempt()
        return { status: 'in-flight', ...(attempt === undefined ? {} : { attempt: attempt.toJSON() }) }
      }
      const notices = []
      let settled
      const begun = authorization.begin({
        key: authorizationKey,
        ...(method === undefined ? {} : { method }),
        interaction: {
          notify: (notice) => notices.push(notice),
          // A tool call has no way to ask; a method that needs an answer is a
          // method this surface must not have chosen.
          prompt: () => Promise.reject(new Error('this surface cannot ask a question; use a method that needs no answer')),
        },
      })
      const outcome = begun.then(
        (result) => ({ result }),
        (error) => ({ error }),
      )
      // The promise outlives this call; observing it here is what keeps a later
      // failure from becoming an unhandled rejection.
      void outcome
      const raced = await Promise.race([outcome, sleep(waitMs ?? loginWaitMs)])
      if (raced === 'timeout') {
        const attempt = pendingAttempt()
        return {
          status: 'pending',
          notices,
          ...(attempt === undefined ? {} : { attempt: attempt.toJSON() }),
          hint: 'open the link above, then call this again or check the status',
        }
      }
      if (raced.error !== undefined) {
        return { status: 'failed', notices, error: raced.error instanceof Error ? raced.error.message : String(raced.error) }
      }
      if (raced.result?.status === 'cancelled') return { status: 'cancelled', notices }
      const credential = await repository.status()
      return { status: 'authorized', notices, credential }
    },

    /**
     * Stop a pending sign-in without touching a stored credential.
     * @returns {{status: string}}
     */
    cancelLogin() {
      for (const manager of [attempts, devices]) {
        const attempt = manager?.pending?.()
        attempt?.cancel('cancelled by the caller')
      }
      return { status: 'cancelled' }
    },

    /**
     * Forget the stored credential and stop anything in flight.
     *
     * The seam owns no revocation, so this is local by contract: the record is
     * removed from this deployment and the provider stops being able to call.
     * @returns {Promise<{status: string}>}
     */
    async logout() {
      for (const manager of [attempts, devices]) {
        const attempt = manager?.pending?.()
        attempt?.cancel('signed out')
      }
      await repository.delete()
      balance?.clear?.()
      return { status: 'signed-out' }
    },

    /**
     * The subscription's own quota: the rate-limit windows ChatGPT reports for
     * this account, which is what "how much is left" means for a subscription
     * rather than for a metered API key.
     *
     * @param {object} [options]
     * @param {boolean} [options.refresh] - ask the vendor instead of using the cache.
     * @returns {Promise<object>}
     */
    async quota({ refresh = false } = {}) {
      if (typeof meter?.openaiQuota !== 'function') {
        return { status: 'unavailable', reason: 'the usage meter is not mounted' }
      }
      const snapshot = await meter.openaiQuota({ force: refresh === true })
      return {
        provider: PROVIDER_ID,
        ...snapshot,
      }
    },

    /**
     * What this deployment has actually called and what it cost.
     *
     * The full meter view is a page's worth of pricing tables and provider
     * lists; a tool result is read by a model, so this reports the numbers and
     * the caveats that change how they should be read — an estimate basis, and
     * models with no rate at all, which would otherwise look free.
     *
     * @param {object} [options]
     * @param {string} [options.sessionId] - restrict the session slice to one session.
     * @param {string} [options.scope] - `today`, `month`, `session` or `all`.
     * @returns {Promise<object>}
     */
    async usage({ sessionId, scope = 'today' } = {}) {
      if (typeof meter?.service?.view !== 'function') {
        return { status: 'unavailable', reason: 'the usage meter is not mounted' }
      }
      const view = meter.service.view(sessionId === undefined ? {} : { sessionId })
      // The estimate's own terms live under `pricing`, not at the top of the
      // view. Reading them from the wrong level is not cosmetic: the fields came
      // out `undefined`, and a tool result carrying `undefined` is refused
      // outright as "not lossless JSON" — the call fails instead of reporting
      // the numbers it had.
      const pricing = view.pricing ?? {}
      const slices = { session: view.usage?.session, today: view.usage?.today, month: view.usage?.month }
      const wanted = scope === 'all' ? Object.keys(slices) : [scope]
      const usage = {}
      for (const key of wanted) {
        if (key === 'session' && sessionId === undefined) continue
        if (slices[key] !== undefined) usage[key] = slices[key]
      }
      return {
        status: 'ok',
        generatedAt: view.generatedAt,
        account: view.account,
        display: view.display,
        privacy: view.privacy,
        ...(sessionId === undefined ? {} : { sessionId }),
        usage,
        estimated: pricing.estimated,
        basis: pricing.basis,
        unpricedModels: pricing.unpricedModels,
        ...(pricing.band === undefined ? {} : { band: pricing.band }),
        balance: view.deepseek,
      }
    },
  }
}
