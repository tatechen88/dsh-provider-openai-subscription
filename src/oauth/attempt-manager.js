/**
 * OAuth login attempt manager.
 *
 * One attempt owns one state/PKCE pair, the loopback callback server, a
 * manual-code fallback, and the token exchange + credential commit.  It is
 * deliberately single-account for the first release.
 *
 * @module dsh-provider-openai-subscription/oauth/attempt-manager
 */

import { randomBytes } from 'node:crypto'
import { OPENAI_TOKEN_URL } from './token-client.js'
import { generatePKCE } from './pkce.js'
import { generateState } from './state.js'
import { parseCallbackInput } from './callback-parser.js'
import { startCallbackServer } from './callback-server.js'
import { extractAccountId, extractEmail } from './jwt.js'
import { createGrant } from '../credentials/schema.js'

/** Stable attempt error. */
export class OAuthAttemptError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   * @param {ErrorOptions} [options]
   */
  constructor(code, message, options) {
    super(message, options)
    this.name = 'OAuthAttemptError'
    this.code = code
  }
}

/** Default authorization endpoint. */
export const OPENAI_AUTH_URL = 'https://auth.openai.com/oauth/authorize'

/** Default OAuth scope. */
export const DEFAULT_OAUTH_SCOPE = 'openid profile email offline_access'

/**
 * Create a unique attempt id.
 * @returns {string}
 */
export function createAttemptId() {
  return randomBytes(16).toString('hex')
}

/**
 * One OAuth login attempt.
 */
export class OAuthAttempt {
  /**
   * @param {object} options
   * @param {string} options.clientId
   * @param {object} options.repository - CredentialRepository-like writer.
   * @param {(options: {clientId: string, code: string, redirectUri: string, codeVerifier: string}) => Promise<{access: string, refresh?: string, expires: number, idToken?: string}>} options.exchange
   * @param {number} [options.port]
   * @param {string} [options.path]
   * @param {string} [options.scope]
   * @param {number} [options.timeoutMs]
   * @param {() => number} [options.now]
   */
  constructor({
    clientId,
    repository,
    exchange,
    port = 1455,
    path = '/auth/callback',
    scope = DEFAULT_OAUTH_SCOPE,
    timeoutMs = 300_000,
    now = Date.now,
  }) {
    if (!clientId || typeof clientId !== 'string') throw new TypeError('OAuthAttempt requires clientId')
    if (!repository || typeof repository.write !== 'function') throw new TypeError('OAuthAttempt requires repository.write')
    if (typeof exchange !== 'function') throw new TypeError('OAuthAttempt requires exchange')
    this.id = createAttemptId()
    this.clientId = clientId
    this.repository = repository
    this.exchange = exchange
    this.port = port
    this.path = path
    this.scope = scope
    this.timeoutMs = timeoutMs
    this.now = now
    this.state = generateState()
    this.pkce = generatePKCE()
    this.status = 'created'
    this.url = undefined
    this.redirectUri = undefined
    this.callbackServer = undefined
    this.timer = undefined
    this.error = undefined
    this.settled = false
    /** @type {Promise<import('../credentials/schema.js').OpenAISubscriptionGrant>|undefined} */
    this.resultPromise = undefined
    this.#resolveResult = undefined
    this.#rejectResult = undefined
  }

  /** @type {((grant: import('../credentials/schema.js').OpenAISubscriptionGrant) => void)|undefined} */
  #resolveResult
  /** @type {((error: Error) => void)|undefined} */
  #rejectResult

  /**
   * Start the callback server and return the authorization URL.
   * @returns {Promise<{attemptId: string, url: string, redirectUri: string}>}
   */
  async start() {
    if (this.status !== 'created') throw new OAuthAttemptError('already-started', 'OAuth attempt was already started')
    this.resultPromise = new Promise((resolve, reject) => {
      this.#resolveResult = resolve
      this.#rejectResult = reject
    })
    // Prevent an unobserved rejection when a caller starts but never awaits
    // the attempt (e.g. plugin disposal cancels a stale UI attempt).
    void this.resultPromise.catch(() => {})
    const server = await startCallbackServer({
      port: this.port,
      path: this.path,
      expectedState: this.state,
      onCode: (code) => { void this.#finishWithCode(code) },
      onError: (error) => { this.#fail(error) },
    })
    this.callbackServer = server
    this.redirectUri = server.redirectUri
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: this.clientId,
      redirect_uri: this.redirectUri,
      scope: this.scope,
      code_challenge: this.pkce.challenge,
      code_challenge_method: 'S256',
      state: this.state,
    })
    this.url = `${OPENAI_AUTH_URL}?${params}`
    this.status = 'waiting'
    this.timer = setTimeout(() => {
      this.#fail(new OAuthAttemptError('timed-out', 'OAuth login timed out'))
    }, this.timeoutMs)
    this.timer.unref?.()
    return { attemptId: this.id, url: this.url, redirectUri: this.redirectUri }
  }

  /**
   * Submit a pasted redirect URL / query / raw code.
   * @param {string} input
   * @returns {{ok: true} | {ok: false, error: string}}
   */
  submitManualCode(input) {
    if (this.status !== 'waiting') {
      return { ok: false, error: this.status === 'exchanging' ? 'already-exchanging' : 'no-login-in-progress' }
    }
    const parsed = parseCallbackInput(input)
    if (!parsed.code) return { ok: false, error: 'no-code' }
    if (parsed.kind !== 'raw' && parsed.state !== this.state) {
      return { ok: false, error: 'state-mismatch' }
    }
    void this.#finishWithCode(parsed.code)
    return { ok: true }
  }

  /**
   * Cancel the attempt.
   * @param {string} [reason]
   * @returns {void}
   */
  cancel(reason = 'OAuth login cancelled') {
    this.#fail(new OAuthAttemptError('cancelled', reason))
  }

  /**
   * Wait for the final stored grant.
   * @returns {Promise<import('../credentials/schema.js').OpenAISubscriptionGrant>}
   */
  async result() {
    if (this.resultPromise === undefined) {
      throw new OAuthAttemptError('not-started', 'OAuth attempt has not been started')
    }
    return this.resultPromise
  }

  /**
   * Public safe state for the UI.
   * @returns {{attemptId: string, status: string, url?: string, redirectUri?: string, errorCode?: string, message?: string}}
   */
  toJSON() {
    return {
      attemptId: this.id,
      status: this.status,
      ...(this.url === undefined ? {} : { url: this.url }),
      ...(this.redirectUri === undefined ? {} : { redirectUri: this.redirectUri }),
      ...(this.error === undefined ? {} : { errorCode: this.error.code, message: this.error.message }),
    }
  }

  /**
   * Exchange a code and persist the grant.
   * @param {string} code
   * @returns {Promise<void>}
   */
  async #finishWithCode(code) {
    if (this.settled || this.status === 'exchanging') return
    this.status = 'exchanging'
    this.#clearTimer()
    try {
      const token = await this.exchange({
        clientId: this.clientId,
        code,
        redirectUri: this.redirectUri,
        codeVerifier: this.pkce.verifier,
      })
      const accountId = extractAccountId(token.idToken, token.access)
      if (!accountId) {
        throw new OAuthAttemptError('account-id-missing', 'OAuth login succeeded but no ChatGPT account id was found')
      }
      const grant = createGrant({
        access: token.access,
        refresh: token.refresh ?? '',
        expires: token.expires,
        accountId,
        ...(extractEmail(token.idToken, token.access) === undefined
          ? {}
          : { email: extractEmail(token.idToken, token.access) }),
      })
      const stored = await this.repository.write(grant)
      this.status = 'authorized'
      this.settled = true
      this.#resolveResult?.(stored)
    } catch (error) {
      this.#fail(error instanceof Error ? error : new Error(String(error)))
    } finally {
      await this.#closeCallbackServer()
    }
  }

  /**
   * Fail the attempt and settle the result promise.
   * @param {Error} error
   * @returns {void}
   */
  #fail(error) {
    if (this.settled) return
    this.settled = true
    this.status = 'failed'
    this.error = error instanceof OAuthAttemptError ? error : new OAuthAttemptError('failed', error.message)
    this.#clearTimer()
    void this.#closeCallbackServer()
    this.#rejectResult?.(this.error)
  }

  #clearTimer() {
    if (this.timer !== undefined) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
  }

  async #closeCallbackServer() {
    const server = this.callbackServer
    this.callbackServer = undefined
    if (server !== undefined) {
      await server.close().catch(() => {})
    }
  }
}

/**
 * Manager for in-memory login attempts.
 */
export class OAuthAttemptManager {
  /**
   * @param {object} options - same options as OAuthAttempt, minus per-attempt exchange.
   */
  constructor(options) {
    this.options = options
    /** @type {Map<string, OAuthAttempt>} */
    this.attempts = new Map()
  }

  /**
   * Create and start a new attempt.
   * @param {object} [overrides]
   * @returns {Promise<{attemptId: string, url: string, redirectUri: string}>}
   */
  async create(overrides = {}) {
    const attempt = new OAuthAttempt({ ...this.options, ...overrides })
    this.attempts.set(attempt.id, attempt)
    try {
      return await attempt.start()
    } catch (error) {
      this.attempts.delete(attempt.id)
      throw error
    }
  }

  /**
   * Get one attempt by id.
   * @param {string} id
   * @returns {OAuthAttempt|undefined}
   */
  get(id) {
    return this.attempts.get(id)
  }

  /**
   * Remove a settled attempt from memory.
   * @param {string} id
   * @returns {boolean}
   */
  remove(id) {
    return this.attempts.delete(id)
  }

  /**
   * Cancel all attempts (plugin disposal).
   * @returns {Promise<void>}
   */
  async dispose() {
    for (const attempt of this.attempts.values()) attempt.cancel('plugin disposed')
    this.attempts.clear()
  }
}
