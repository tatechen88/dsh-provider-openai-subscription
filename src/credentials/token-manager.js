/**
 * Token lifecycle manager.
 *
 * Reads grants through the repository, refreshes near-expiry access tokens,
 * and single-flights concurrent refreshes so one refresh token is never
 * consumed twice in the same process.  Terminal refresh errors must be mapped
 * by the caller-provided refresh function to a thrown
 * {@link TokenManagerError} with a stable code; the manager persists
 * `needsReauth` for terminal codes.
 *
 * @module dsh-provider-openai-subscription/credentials/token-manager
 */

import { CredentialSchemaError } from './schema.js'

/** Default early-refresh window. */
export const DEFAULT_REFRESH_SKEW_MS = 5 * 60 * 1000

/**
 * Stable token manager error.
 */
export class TokenManagerError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   * @param {ErrorOptions} [options]
   */
  constructor(code, message, options) {
    super(message, options)
    this.name = 'TokenManagerError'
    this.code = code
  }
}

/**
 * Refresh-call result.
 * @typedef {object} RefreshResult
 * @property {string} access
 * @property {string} [refresh]
 * @property {number} expires
 * @property {string} [accountId]
 * @property {string} [email]
 */

/**
 * Token manager over a {@link import('./repository.js').CredentialRepository}.
 */
export class TokenManager {
  /**
   * @param {object} options
   * @param {import('./repository.js').CredentialRepository} options.repository
   * @param {(refreshToken: string, signal?: AbortSignal) => Promise<RefreshResult>} options.refreshFn
   * @param {number} [options.refreshSkewMs]
   * @param {() => number} [options.now]
   */
  constructor({ repository, refreshFn, refreshSkewMs = DEFAULT_REFRESH_SKEW_MS, now = Date.now }) {
    if (!repository) throw new TypeError('TokenManager requires a repository')
    if (typeof refreshFn !== 'function') throw new TypeError('TokenManager requires refreshFn')
    this.repository = repository
    this.refreshFn = refreshFn
    this.refreshSkewMs = refreshSkewMs
    this.now = now
    /** @type {Promise<import('./schema.js').OpenAISubscriptionGrant>|undefined} */
    this.flight = undefined
  }

  /**
   * Return a valid access token snapshot for one request, refreshing if
   * needed.
   * @param {object} [options]
   * @param {AbortSignal} [options.signal]
   * @param {boolean} [options.force]
   * @returns {Promise<{accessToken: string, accountId: string, grant: import('./schema.js').OpenAISubscriptionGrant}>}
   */
  async getAccessSnapshot(options = {}) {
    const grant = await this.repository.read()
    if (grant === undefined) {
      throw new TokenManagerError('not-signed-in', 'OpenAI subscription is not signed in')
    }
    if (grant.needsReauth === true) {
      throw new TokenManagerError('reauth-required', 'OpenAI subscription credential requires reauthentication')
    }
    const usable = options.force !== true && grant.expires > this.now() + this.refreshSkewMs
    if (usable) return { accessToken: grant.access, accountId: grant.accountId, grant }
    const refreshed = await this.refresh(options.signal)
    return { accessToken: refreshed.access, accountId: refreshed.accountId, grant: refreshed }
  }

  /**
   * Refresh the current grant.  Concurrent callers share one flight.
   * @param {AbortSignal} [signal]
   * @returns {Promise<import('./schema.js').OpenAISubscriptionGrant>}
   */
  refresh(signal) {
    if (this.flight === undefined) {
      this.flight = this.#refreshOnce(signal).finally(() => {
        this.flight = undefined
      })
    }
    return this.flight
  }

  /**
   * Mark the current grant as needing reauthentication.  This is used after a
   * terminal refresh failure observed by a caller.
   * @param {string} [reason]
   * @returns {Promise<void>}
   */
  async markNeedsReauth(reason = 'OpenAI subscription credential was rejected') {
    await this.repository.mutate(async (current) => {
      if (current === undefined) return undefined
      return { ...current, needsReauth: true }
    })
    void reason
  }

  /**
   * One actual refresh pass with generation safety.
   * @param {AbortSignal} [signal]
   * @returns {Promise<import('./schema.js').OpenAISubscriptionGrant>}
   */
  async #refreshOnce(signal) {
    const current = await this.repository.read()
    if (current === undefined) {
      throw new TokenManagerError('not-signed-in', 'OpenAI subscription is not signed in')
    }
    if (current.needsReauth === true) {
      throw new TokenManagerError('reauth-required', 'OpenAI subscription credential requires reauthentication')
    }
    let fresh
    try {
      fresh = await this.refreshFn(current.refresh, signal)
    } catch (error) {
      if (error instanceof TokenManagerError && isTerminalRefreshCode(error.code)) {
        await this.repository.mutate(async (grant) => {
          if (grant === undefined || grant.refresh !== current.refresh) return grant
          return { ...grant, needsReauth: true }
        })
      }
      throw error
    }
    const merged = {
      schemaVersion: 1,
      type: 'oauth',
      access: fresh.access,
      refresh: fresh.refresh && fresh.refresh.length > 0 ? fresh.refresh : current.refresh,
      expires: fresh.expires,
      accountId: fresh.accountId && fresh.accountId.length > 0 ? fresh.accountId : current.accountId,
      ...(fresh.email !== undefined && fresh.email.length > 0 ? { email: fresh.email } : current.email === undefined ? {} : { email: current.email }),
      obtainedAt: this.now(),
    }
    const saved = await this.repository.mutate(async (grant) => {
      // Another process already rotated the refresh token: adopt its newer
      // grant instead of overwriting it with our older generation.
      if (grant !== undefined && grant.refresh !== current.refresh) return grant
      return merged
    })
    if (saved === undefined) {
      throw new TokenManagerError('refresh-lost', 'OpenAI subscription credential disappeared during refresh')
    }
    if (saved.needsReauth === true) {
      throw new TokenManagerError('reauth-required', 'OpenAI subscription credential requires reauthentication')
    }
    return saved
  }
}

/**
 * True when a refresh error code means the credential is permanently invalid.
 * @param {string} code
 * @returns {boolean}
 */
export function isTerminalRefreshCode(code) {
  return code === 'invalid_grant'
    || code === 'refresh_token_reused'
    || code === 'revoked'
    || code === 'expired_token'
    || code === 'access_denied'
}
