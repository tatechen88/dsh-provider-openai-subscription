/**
 * Balance/usage upstream client.
 *
 * Requests `https://chatgpt.com/backend-api/wham/usage` with the same token
 * snapshot used for model requests.  The browser never calls this endpoint.
 *
 * @module dsh-provider-openai-subscription/balance/client
 */

import { normalizeBalanceResponse } from './normalizer.js'

/** Upstream usage endpoint. */
export const OPENAI_USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage'

/** Stable balance client error. */
export class BalanceClientError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   * @param {ErrorOptions} [options]
   */
  constructor(code, message, options) {
    super(message, options)
    this.name = 'BalanceClientError'
    this.code = code
  }
}

/**
 * Fetch the usage snapshot using a token manager access snapshot.
 * @param {object} options
 * @param {() => Promise<{accessToken: string, accountId: string}>} options.getAccess
 * @param {(url: string, init: RequestInit) => Promise<Response>} [options.fetchImpl]
 * @param {number} [options.timeoutMs]
 * @returns {Promise<import('./types.js').BalanceSnapshot>}
 */
export async function fetchBalance({ getAccess, fetchImpl = fetch, timeoutMs = 30_000 }) {
  let access
  try {
    access = await getAccess()
  } catch (error) {
    const code = /** @type {{code?: string}} */ (error).code
    if (code === 'not-signed-in') throw new BalanceClientError('not-signed-in', 'OpenAI subscription is not signed in')
    if (code === 'reauth-required') throw new BalanceClientError('reauth-required', 'OpenAI subscription requires reauthentication')
    throw new BalanceClientError('credential', 'Unable to read OpenAI subscription credentials', { cause: error })
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  timer.unref?.()
  let response
  try {
    response = await fetchImpl(OPENAI_USAGE_URL, {
      method: 'GET',
      headers: {
        authorization: `Bearer ${access.accessToken}`,
        'chatgpt-account-id': access.accountId,
        accept: 'application/json',
      },
      signal: controller.signal,
      redirect: 'error',
    })
  } catch (error) {
    throw new BalanceClientError('network', `Balance request failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error })
  } finally {
    clearTimeout(timer)
  }
  const text = await response.text()
  let data
  try {
    data = JSON.parse(text)
  } catch {
    throw new BalanceClientError('invalid-json', `Balance endpoint returned non-JSON (HTTP ${response.status})`)
  }
  if (response.status === 401 || response.status === 403) {
    throw new BalanceClientError('unauthorized', 'OpenAI subscription credential was rejected; sign in again')
  }
  if (response.status === 429) {
    throw new BalanceClientError('rate-limited', 'OpenAI subscription balance is rate limited')
  }
  if (!response.ok) {
    throw new BalanceClientError('upstream-error', `Balance endpoint returned HTTP ${response.status}`)
  }
  try {
    return normalizeBalanceResponse(data)
  } catch (error) {
    const schemaError = /** @type {{code?: string, message?: string}} */ (error)
    throw new BalanceClientError(schemaError.code ?? 'schema-changed', schemaError.message ?? 'Balance response schema changed')
  }
}
