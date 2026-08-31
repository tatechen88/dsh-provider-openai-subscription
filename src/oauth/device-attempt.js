/**
 * Device-code OAuth attempt.
 *
 * Provides the same external interface shape as {@link OAuthAttempt} but for
 * headless/remote-browser scenarios: the user opens a verification URL and
 * enters a code, and this attempt polls until the authorization code is
 * issued.
 *
 * @module dsh-provider-openai-subscription/oauth/device-attempt
 */

import { randomBytes } from 'node:crypto'
import {
  startDeviceAuth, pollDeviceAuth, DEVICE_REDIRECT_URI, DEVICE_VERIFICATION_URI, DeviceFlowError,
} from './device-client.js'
import { extractAccountId, extractEmail } from './jwt.js'
import { createGrant } from '../credentials/schema.js'

/** Stable device attempt error. */
export class DeviceOAuthAttemptError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   * @param {ErrorOptions} [options]
   */
  constructor(code, message, options) {
    super(message, options)
    this.name = 'DeviceOAuthAttemptError'
    this.code = code
  }
}

/**
 * One device-code login attempt.
 */
export class DeviceOAuthAttempt {
  /**
   * @param {object} options
   * @param {string} options.clientId
   * @param {object} options.repository - CredentialRepository-like writer.
   * @param {(options: {clientId: string, code: string, redirectUri: string, codeVerifier: string}) => Promise<{access: string, refresh?: string, expires: number, idToken?: string}>} options.exchange
   * @param {(url: string, init: RequestInit) => Promise<Response>} [options.fetchImpl]
   * @param {number} [options.timeoutSeconds]
   */
  constructor({ clientId, repository, exchange, fetchImpl = fetch, timeoutSeconds = 300 }) {
    if (!clientId || typeof clientId !== 'string') throw new TypeError('DeviceOAuthAttempt requires clientId')
    if (!repository || typeof repository.write !== 'function') throw new TypeError('DeviceOAuthAttempt requires repository.write')
    if (typeof exchange !== 'function') throw new TypeError('DeviceOAuthAttempt requires exchange')
    this.id = randomBytes(16).toString('hex')
    this.clientId = clientId
    this.repository = repository
    this.exchange = exchange
    this.fetchImpl = fetchImpl
    this.timeoutSeconds = timeoutSeconds
    this.controller = new AbortController()
    this.status = 'created'
    this.device = undefined
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
   * Start the device flow.
   * @returns {Promise<{attemptId: string, verificationUri: string, userCode: string, intervalSeconds: number, expiresInSeconds: number}>}
   */
  async start() {
    if (this.status !== 'created') throw new DeviceOAuthAttemptError('already-started', 'Device attempt was already started')
    this.resultPromise = new Promise((resolve, reject) => {
      this.#resolveResult = resolve
      this.#rejectResult = reject
    })
    void this.resultPromise.catch(() => {})
    try {
      this.device = await startDeviceAuth({ clientId: this.clientId, fetchImpl: this.fetchImpl, signal: this.controller.signal })
      this.status = 'waiting'
      return {
        attemptId: this.id,
        verificationUri: DEVICE_VERIFICATION_URI,
        userCode: this.device.userCode,
        intervalSeconds: this.device.intervalSeconds,
        expiresInSeconds: this.timeoutSeconds,
      }
    } catch (error) {
      this.#fail(error)
      throw error
    }
  }

  /**
   * Wait for the final stored grant.
   * @returns {Promise<import('../credentials/schema.js').OpenAISubscriptionGrant>}
   */
  async result() {
    if (this.resultPromise === undefined) throw new DeviceOAuthAttemptError('not-started', 'Device attempt has not been started')
    return this.resultPromise
  }

  /**
   * Cancel the attempt.
   * @param {string} [reason]
   */
  cancel(reason = 'Device login cancelled') {
    this.controller.abort(new DeviceOAuthAttemptError('cancelled', reason))
    this.#fail(new DeviceOAuthAttemptError('cancelled', reason))
  }

  /**
   * Public safe state for the UI.
   * @returns {{attemptId: string, status: string, verificationUri?: string, userCode?: string, errorCode?: string, message?: string}}
   */
  toJSON() {
    return {
      attemptId: this.id,
      status: this.status,
      ...(this.device === undefined ? {} : { verificationUri: DEVICE_VERIFICATION_URI, userCode: this.device.userCode }),
      ...(this.error === undefined ? {} : { errorCode: this.error.code, message: this.error.message }),
    }
  }

  /**
   * Poll and complete the flow.
   * @returns {Promise<import('../credentials/schema.js').OpenAISubscriptionGrant>}
   */
  async #run() {
    try {
      if (this.device === undefined) throw new DeviceOAuthAttemptError('not-started', 'Device attempt has not been started')
      const deviceCode = await pollDeviceAuth({
        device: this.device,
        fetchImpl: this.fetchImpl,
        signal: this.controller.signal,
        timeoutSeconds: this.timeoutSeconds,
      })
      this.status = 'exchanging'
      const token = await this.exchange({
        clientId: this.clientId,
        code: deviceCode.authorizationCode,
        redirectUri: DEVICE_REDIRECT_URI,
        codeVerifier: deviceCode.codeVerifier,
      })
      const accountId = extractAccountId(token.idToken, token.access)
      if (!accountId) {
        throw new DeviceOAuthAttemptError('account-id-missing', 'Device login succeeded but no ChatGPT account id was found')
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
      return stored
    } catch (error) {
      const wrapped = error instanceof DeviceFlowError || error instanceof DeviceOAuthAttemptError
        ? error
        : new DeviceOAuthAttemptError('failed', error instanceof Error ? error.message : String(error))
      this.#fail(wrapped)
      throw wrapped
    }
  }

  /**
   * Start polling in the background and expose the result promise.
   * @returns {Promise<import('../credentials/schema.js').OpenAISubscriptionGrant>}
   */
  run() {
    void this.#run().catch(() => {})
    const promise = this.result()
    void promise.catch(() => {})
    return promise
  }

  #fail(error) {
    if (this.settled) return
    this.settled = true
    this.status = 'failed'
    this.error = error
    this.#rejectResult?.(error)
  }
}

/**
 * Manager for device-code attempts.
 */
export class DeviceOAuthAttemptManager {
  /**
   * @param {object} options
   */
  constructor(options) {
    this.options = options
    /** @type {Map<string, DeviceOAuthAttempt>} */
    this.attempts = new Map()
  }

  /**
   * Create and start a device attempt.
   * @param {object} [overrides]
   * @returns {Promise<{attemptId: string, verificationUri: string, userCode: string, intervalSeconds: number, expiresInSeconds: number}>}
   */
  async create(overrides = {}) {
    const attempt = new DeviceOAuthAttempt({ ...this.options, ...overrides })
    this.attempts.set(attempt.id, attempt)
    try {
      const info = await attempt.start()
      attempt.run()
      return info
    } catch (error) {
      this.attempts.delete(attempt.id)
      throw error
    }
  }

  /**
   * Get one attempt by id.
   * @param {string} id
   * @returns {DeviceOAuthAttempt|undefined}
   */
  get(id) {
    return this.attempts.get(id)
  }

  /**
   * Remove a settled attempt.
   * @param {string} id
   * @returns {boolean}
   */
  remove(id) {
    return this.attempts.delete(id)
  }

  /**
   * Cancel all attempts.
   * @returns {Promise<void>}
   */
  async dispose() {
    for (const attempt of this.attempts.values()) attempt.cancel('plugin disposed')
    this.attempts.clear()
  }
}
