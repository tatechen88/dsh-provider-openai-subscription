/**
 * DeepSeek official account balance.
 *
 * The public surface is a single documented endpoint:
 * `GET https://api.deepseek.com/user/balance`.  It answers with the account's
 * currency rows (granted and topped-up balance); it does not answer with an
 * account kind, a credit line, or a bill.  This module reads exactly that and
 * refuses every other host, because the API key must never leave the official
 * domain.
 *
 * @module dsh-provider-openai-subscription/usage/deepseek-balance
 */

/** Official balance path appended to the account base URL. */
export const DEEPSEEK_BALANCE_PATH = '/user/balance'

/** Host allowed to receive the DeepSeek API key. */
export const DEEPSEEK_OFFICIAL_HOST = 'api.deepseek.com'

/** Default request timeout. */
export const DEEPSEEK_BALANCE_TIMEOUT_MS = 15_000

/** Stable balance error carrying a UI-facing classification. */
export class DeepSeekBalanceError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   */
  constructor(code, message) {
    super(message)
    this.name = 'DeepSeekBalanceError'
    this.code = code
  }
}

/**
 * Resolve the balance endpoint for one configured base URL.
 *
 * Only HTTPS on the official host is accepted; a self-hosted or proxied base
 * URL yields null so the caller refuses instead of forwarding the key.
 * @param {unknown} baseURL
 * @returns {string|null}
 */
export function resolveOfficialEndpoint(baseURL) {
  const raw = typeof baseURL === 'string' ? baseURL.trim() : ''
  const candidate = raw.length === 0 ? `https://${DEEPSEEK_OFFICIAL_HOST}` : raw
  let parsed
  try {
    parsed = new URL(candidate)
  } catch {
    return null
  }
  if (parsed.protocol !== 'https:') return null
  if (parsed.host.toLowerCase() !== DEEPSEEK_OFFICIAL_HOST) return null
  const base = parsed.origin + parsed.pathname.replace(/\/+$/, '').replace(/\/v\d+$/i, '')
  return `${base}${DEEPSEEK_BALANCE_PATH}`
}

/**
 * Read one decimal amount from the wire without trusting its type.
 *
 * The sign is kept: a negative total is a real account state (arrears), and
 * dropping the row would hide money. Only a value that is not a finite number
 * is unreadable.
 * @param {unknown} value
 * @returns {number|undefined}
 */
function amount(value) {
  const parsed = typeof value === 'string' ? Number(value) : typeof value === 'number' ? value : Number.NaN
  return Number.isFinite(parsed) ? parsed : undefined
}

/**
 * Choose the currency row the sidebar shows first.
 *
 * The documented order of `balance_infos` is not stable, so the choice is made
 * from the values: a funded CNY row, then any funded row, then CNY, then the
 * first row.
 * @param {readonly object[]} infos
 * @returns {object|undefined}
 */
export function pickPrimaryInfo(infos) {
  if (infos.length === 0) return undefined
  const positiveCny = infos.find((info) => info.currency === 'CNY' && info.total > 0)
  if (positiveCny !== undefined) return positiveCny
  const positive = infos.find((info) => info.total > 0)
  if (positive !== undefined) return positive
  return infos.find((info) => info.currency === 'CNY') ?? infos[0]
}

/**
 * Normalize the documented response body.
 *
 * Every currency row is kept: a multi-currency account returns more than one,
 * and dropping the rest would hide real money.
 * @param {unknown} data
 * @returns {{available: boolean, infos: object[], primary: object|undefined}}
 */
export function normalizeBalanceInfos(data) {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    throw new DeepSeekBalanceError('malformed-response', 'DeepSeek balance response is not an object')
  }
  const record = /** @type {Record<string, unknown>} */ (data)
  const rows = record.balance_infos
  if (!Array.isArray(rows)) {
    throw new DeepSeekBalanceError('malformed-response', 'DeepSeek balance response has no balance_infos array')
  }
  const infos = []
  for (const row of rows) {
    if (row === null || typeof row !== 'object' || Array.isArray(row)) continue
    const info = /** @type {Record<string, unknown>} */ (row)
    const total = amount(info.total_balance)
    if (typeof info.currency !== 'string' || info.currency.length === 0 || total === undefined) continue
    infos.push({
      currency: info.currency,
      total,
      granted: amount(info.granted_balance) ?? 0,
      toppedUp: amount(info.topped_up_balance) ?? 0,
    })
  }
  return { available: record.is_available === true, infos, primary: pickPrimaryInfo(infos) }
}

/**
 * Fetch the official balance snapshot.
 * @param {object} options
 * @param {string|undefined} options.baseURL - configured DeepSeek base URL.
 * @param {string|undefined} options.apiKey - resolved credential value.
 * @param {(url: string, init: object) => Promise<Response>} [options.fetchImpl]
 * @param {number} [options.timeoutMs]
 * @param {() => number} [options.now]
 * @returns {Promise<object>} normalized snapshot.
 */
export async function fetchDeepSeekBalance({
  baseURL,
  apiKey,
  fetchImpl = globalThis.fetch,
  timeoutMs = DEEPSEEK_BALANCE_TIMEOUT_MS,
  now = Date.now,
}) {
  if (typeof apiKey !== 'string' || apiKey.length === 0) {
    throw new DeepSeekBalanceError('unconfigured', 'No DeepSeek API key is configured')
  }
  const endpoint = resolveOfficialEndpoint(baseURL)
  if (endpoint === null) {
    throw new DeepSeekBalanceError(
      'unsupported-endpoint',
      `DeepSeek balance is only read from https://${DEEPSEEK_OFFICIAL_HOST}; refusing to send the API key to "${String(baseURL ?? '')}"`,
    )
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  timer.unref?.()
  try {
    let response
    try {
      response = await fetchImpl(endpoint, {
        method: 'GET',
        headers: { authorization: `Bearer ${apiKey}`, accept: 'application/json' },
        signal: controller.signal,
        redirect: 'error',
      })
    } catch (error) {
      const aborted = error !== null && typeof error === 'object' && error.name === 'AbortError'
      throw new DeepSeekBalanceError(
        aborted ? 'timeout' : 'network',
        `DeepSeek balance request failed: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
    if (!response.ok) {
      throw new DeepSeekBalanceError('http', `DeepSeek balance returned HTTP ${response.status}`)
    }
    // The timeout has to cover the body as well: a server that sends headers and
    // then stalls would otherwise hold the single-flight refresh open for every
    // caller until the runtime's much longer default expires.
    const body = await response.json().catch((error) => {
      if (error !== null && typeof error === 'object' && error.name === 'AbortError') {
        throw new DeepSeekBalanceError('timeout', `DeepSeek balance body timed out after ${timeoutMs}ms`)
      }
      return undefined
    })
    const normalized = normalizeBalanceInfos(body)
    return { ...normalized, fetchedAt: now() }
  } finally {
    clearTimeout(timer)
  }
}
