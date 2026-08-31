/**
 * OpenAI Auth token endpoint client.
 *
 * This module talks to `https://auth.openai.com/oauth/token` only.  It is a
 * public OAuth client (no client secret), using form-urlencoded bodies.
 *
 * @module dsh-provider-openai-subscription/oauth/token-client
 */

/** OpenAI Auth token endpoint. */
export const OPENAI_TOKEN_URL = 'https://auth.openai.com/oauth/token'

/** Stable OAuth token error. */
export class OAuthTokenError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   * @param {ErrorOptions} [options]
   */
  constructor(code, message, options) {
    super(message, options)
    this.name = 'OAuthTokenError'
    this.code = code
  }
}

/**
 * Parse and validate a token endpoint JSON body.
 * @param {unknown} data
 * @returns {{access: string, refresh?: string, expires: number, idToken?: string}}
 */
export function parseTokenResponse(data) {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    throw new OAuthTokenError('invalid-json', 'OAuth token endpoint returned a non-object body')
  }
  const record = /** @type {Record<string, unknown>} */ (data)
  const access = record.access_token
  if (typeof access !== 'string' || access.length === 0) {
    throw new OAuthTokenError('missing-access-token', 'OAuth token endpoint returned no access token')
  }
  const refresh = record.refresh_token
  if (refresh !== undefined && (typeof refresh !== 'string' || refresh.length === 0)) {
    throw new OAuthTokenError('malformed-refresh-token', 'OAuth token endpoint returned a malformed refresh token')
  }
  const rawExpiresIn = record.expires_in
  const expiresIn = typeof rawExpiresIn === 'number' && Number.isFinite(rawExpiresIn) && rawExpiresIn >= 0
    ? rawExpiresIn
    : 3600
  const computed = Date.now() + expiresIn * 1000
  const expires = Number.isFinite(computed) ? computed : Date.now() + 3600 * 1000
  const idToken = record.id_token
  if (idToken !== undefined && (typeof idToken !== 'string' || idToken.length === 0)) {
    throw new OAuthTokenError('malformed-id-token', 'OAuth token endpoint returned a malformed id token')
  }
  return {
    access,
    ...(refresh === undefined ? {} : { refresh }),
    expires,
    ...(idToken === undefined ? {} : { idToken }),
  }
}

/**
 * Perform one fetch against the token endpoint with a bounded body.
 * @param {object} options
 * @param {URLSearchParams} options.body
 * @param {(url: string, init: RequestInit) => Promise<Response>} [options.fetchImpl]
 * @param {number} [options.timeoutMs]
 * @returns {Promise<ReturnType<typeof parseTokenResponse>>}
 */
async function postToken({ body, fetchImpl = fetch, timeoutMs = 30_000 }) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  timer.unref?.()
  let response
  try {
    response = await fetchImpl(OPENAI_TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: body.toString(),
      signal: controller.signal,
      redirect: 'error',
    })
  } catch (error) {
    throw new OAuthTokenError('network', `OAuth token endpoint request failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error })
  } finally {
    clearTimeout(timer)
  }
  const text = await response.text()
  let data
  try {
    data = JSON.parse(text)
  } catch {
    throw new OAuthTokenError('invalid-json', `OAuth token endpoint returned non-JSON (HTTP ${response.status})`)
  }
  if (!response.ok) {
    const description = typeof data === 'object' && data !== null
      ? [data.error, data.error_description].filter((value) => typeof value === 'string' && value.length > 0).join(': ')
      : ''
    throw new OAuthTokenError('token-exchange-failed', `OAuth token endpoint rejected the request (HTTP ${response.status}${description ? `: ${description}` : ''})`)
  }
  return parseTokenResponse(data)
}

/**
 * Exchange an authorization code for tokens.
 * @param {object} options
 * @param {string} options.clientId
 * @param {string} options.code
 * @param {string} options.redirectUri
 * @param {string} options.codeVerifier
 * @param {(url: string, init: RequestInit) => Promise<Response>} [options.fetchImpl]
 * @param {number} [options.timeoutMs]
 * @returns {Promise<ReturnType<typeof parseTokenResponse>>}
 */
export function exchangeAuthorizationCode({ clientId, code, redirectUri, codeVerifier, fetchImpl, timeoutMs }) {
  return postToken({
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: clientId,
      code,
      redirect_uri: redirectUri,
      code_verifier: codeVerifier,
    }),
    fetchImpl,
    timeoutMs,
  })
}

/**
 * Refresh an access token.
 * @param {object} options
 * @param {string} options.clientId
 * @param {string} options.refreshToken
 * @param {(url: string, init: RequestInit) => Promise<Response>} [options.fetchImpl]
 * @param {number} [options.timeoutMs]
 * @returns {Promise<ReturnType<typeof parseTokenResponse>>}
 */
export function refreshAccessToken({ clientId, refreshToken, fetchImpl, timeoutMs }) {
  return postToken({
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: clientId,
      refresh_token: refreshToken,
    }),
    fetchImpl,
    timeoutMs,
  })
}
