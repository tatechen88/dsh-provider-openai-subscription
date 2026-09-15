/**
 * Zhipu / GLM account readings.
 *
 * Three official readings describe one Z.AI or BigModel account, and which of
 * them carries data depends on what the account bought:
 *
 * - `quota`   — the Coding Plan usage windows (`/api/monitor/usage/quota/limit`).
 *               An account without a plan answers HTTP 200 with business code
 *               500 and the message "当前用户不存在coding plan": that is *not
 *               applicable*, never a failure and never a zero.
 * - `balance` — the pay-as-you-go cash account
 *               (`/api/biz/account/query-customer-account-report`).
 * - `packages`— token and per-use resource packages
 *               (`/api/biz/tokenAccounts/list/my`).
 *
 * Both stations expose the same paths and JSON shapes; only the host and the
 * `Authorization` scheme differ. The China station authenticates the monitor
 * endpoint with the raw key while the international station and every balance
 * endpoint use `Bearer`. The host is therefore part of the request contract, so
 * a caller never supplies one: it is chosen from this module's allowlist, which
 * is what keeps the account key off any other server.
 *
 * @module dsh-provider-openai-subscription/usage/zhipu-account
 */

/** Official stations, by the provider route they serve. */
export const ZHIPU_HOSTS = Object.freeze({
  /** `zai-coding-cn`, and any route served by the China coding-plan endpoint. */
  'zai-coding-cn': 'https://open.bigmodel.cn',
  /** `zai`, the international route. */
  zai: 'https://api.z.ai',
})

/** Endpoint paths; both stations serve the same ones. */
export const ZHIPU_PATHS = Object.freeze({
  quota: '/api/monitor/usage/quota/limit',
  subscription: '/api/biz/subscription/list',
  accountReport: '/api/biz/account/query-customer-account-report',
  tokenAccounts: '/api/biz/tokenAccounts/list/my',
})

/** Business code the stations return for a feature the account does not have. */
const NOT_APPLICABLE_CODE = 500

/** Default request bound, in milliseconds, covering the body read as well. */
export const ZHIPU_TIMEOUT_MS = 15_000

/** Stable account-reading failure. */
export class ZhipuAccountError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   */
  constructor(code, message) {
    super(message)
    this.name = 'ZhipuAccountError'
    this.code = code
  }
}

/**
 * The official host for one provider route.
 *
 * A route this module does not serve has no host: the caller must not fall back
 * to a configured endpoint, because the account key would then be sent wherever
 * that endpoint points.
 * @param {string|undefined} providerId
 * @returns {string|undefined}
 */
export function hostForProvider(providerId) {
  if (typeof providerId !== 'string') return undefined
  return Object.prototype.hasOwnProperty.call(ZHIPU_HOSTS, providerId) ? ZHIPU_HOSTS[providerId] : undefined
}

/**
 * The `Authorization` header one station expects.
 * @param {string} host - an allowlisted station.
 * @param {string} apiKey
 * @returns {string}
 */
export function authorizationFor(host, apiKey) {
  return host === ZHIPU_HOSTS['zai-coding-cn'] ? apiKey : `Bearer ${apiKey}`
}

/**
 * Whether a response body reports a business-level refusal.
 * @param {unknown} body
 * @returns {boolean}
 */
function refused(body) {
  if (body === null || typeof body !== 'object') return false
  const record = /** @type {Record<string, unknown>} */ (body)
  return record.success === false || (typeof record.code === 'number' && record.code !== 200)
}

/**
 * The message a business-level refusal carries, for the tooltip.
 * @param {unknown} body
 * @returns {string}
 */
function refusalMessage(body) {
  if (body === null || typeof body !== 'object') return 'the station refused the request'
  const message = /** @type {Record<string, unknown>} */ (body).msg
  return typeof message === 'string' && message.length > 0 ? message : 'the station refused the request'
}

/**
 * Read one finite number that may arrive as a numeric string.
 *
 * Empty strings are rejected rather than read as zero: the stations return `""`
 * for "not reported", and a zero balance is a different fact.
 * @param {unknown} value
 * @returns {number|undefined}
 */
function finiteNumber(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return undefined
}

/**
 * Parse the Coding Plan quota reading.
 * @param {unknown} body
 * @returns {{applicable: boolean, windows: object[], reason?: string}}
 */
export function parseQuota(body) {
  if (refused(body)) {
    // "You have no coding plan" is a property of the account, not a defect: the
    // view says so instead of drawing an empty percentage.
    return { applicable: false, windows: [], reason: refusalMessage(body) }
  }
  const data = /** @type {Record<string, unknown>} */ (body).data
  const container = data ?? body
  const limits = Array.isArray(container)
    ? container
    : container !== null && typeof container === 'object' && Array.isArray(/** @type {Record<string, unknown>} */ (container).limits)
      ? /** @type {Record<string, unknown>} */ (container).limits
      : []
  const windows = []
  for (const entry of limits) {
    if (entry === null || typeof entry !== 'object') continue
    const limit = /** @type {Record<string, unknown>} */ (entry)
    const type = typeof limit.type === 'string' ? limit.type : typeof limit.name === 'string' ? limit.name : undefined
    if (type === undefined) continue
    const used = finiteNumber(limit.percentage) ?? finiteNumber(limit.currentValue) ?? 0
    windows.push({
      id: `${type}:${String(finiteNumber(limit.unit) ?? 'default')}`,
      type,
      unit: finiteNumber(limit.unit),
      usedPercent: used,
      remainingPercent: Math.max(0, 100 - used),
      ...(finiteNumber(limit.nextResetTime) === undefined ? {} : { resetsAt: finiteNumber(limit.nextResetTime) }),
      ...(finiteNumber(limit.usage) === undefined ? {} : { limit: finiteNumber(limit.usage) }),
    })
  }
  return windows.length === 0
    ? { applicable: true, windows: [], reason: 'the plan reports no usage windows' }
    : { applicable: true, windows }
}

/**
 * Parse the cash account report.
 * @param {unknown} body
 * @returns {object|undefined}
 */
export function parseAccountReport(body) {
  if (refused(body)) return undefined
  const data = /** @type {Record<string, unknown>} */ (body).data
  if (data === null || typeof data !== 'object') return undefined
  const record = /** @type {Record<string, unknown>} */ (data)
  const available = finiteNumber(record.availableBalance) ?? finiteNumber(record.balance)
  if (available === undefined) return undefined
  const read = (key) => finiteNumber(record[key])
  return {
    currency: 'CNY',
    available,
    // Total spend is the account-side answer to "how much have I used", which
    // the ledger cannot know for calls made outside this harness.
    ...(read('totalSpendAmount') === undefined ? {} : { spent: read('totalSpendAmount') }),
    ...(read('rechargeAmount') === undefined ? {} : { recharged: read('rechargeAmount') }),
    ...(read('giveAmount') === undefined ? {} : { gifted: read('giveAmount') }),
    ...(read('frozenBalance') === undefined ? {} : { frozen: read('frozenBalance') }),
    ...(typeof record.creditStatus === 'string' ? { creditStatus: record.creditStatus } : {}),
  }
}

/**
 * Parse the resource-package list.
 * @param {unknown} body
 * @returns {object[]}
 */
export function parseTokenAccounts(body) {
  if (refused(body)) return []
  const rows = /** @type {Record<string, unknown>} */ (body).rows
  if (!Array.isArray(rows)) return []
  const packages = []
  for (const row of rows) {
    if (row === null || typeof row !== 'object') continue
    const entry = /** @type {Record<string, unknown>} */ (row)
    if (typeof entry.status === 'string' && entry.status !== 'EFFECTIVE') continue
    const remaining = finiteNumber(entry.tokenBalance) ?? finiteNumber(entry.availableBalance)
    if (remaining === undefined) continue
    const consumeType = typeof entry.consumeType === 'string' ? entry.consumeType : 'TOKENS'
    packages.push({
      name: typeof entry.resourcePackageName === 'string' && entry.resourcePackageName.length > 0
        ? entry.resourcePackageName
        : 'Resource package',
      // TOKENS packages count tokens; TIMES packages count uses (image, search).
      kind: consumeType === 'TIMES' ? 'times' : 'tokens',
      remaining,
      ...(finiteNumber(entry.tokensMagnitude) === undefined ? {} : { magnitude: finiteNumber(entry.tokensMagnitude) }),
      ...(typeof entry.expirationTime === 'string' ? { expiresAt: entry.expirationTime } : {}),
      ...(typeof entry.suitableModel === 'string' ? { scope: entry.suitableModel } : {}),
    })
  }
  return packages
}

/** One GET with a bounded body read and the station's own auth scheme. */
async function get({ host, path, apiKey, fetchImpl, timeoutMs, now }) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  timer.unref?.()
  try {
    let response
    try {
      response = await fetchImpl(`${host}${path}`, {
        method: 'GET',
        headers: { authorization: authorizationFor(host, apiKey), accept: 'application/json' },
        signal: controller.signal,
        redirect: 'error',
      })
    } catch (error) {
      const aborted = error !== null && typeof error === 'object' && error.name === 'AbortError'
      throw new ZhipuAccountError(aborted ? 'timeout' : 'network', `Zhipu request failed: ${error instanceof Error ? error.message : String(error)}`)
    }
    if (!response.ok) throw new ZhipuAccountError('http', `Zhipu station returned HTTP ${response.status}`)
    // The bound has to cover the body too, or a station that answers with headers
    // and then stalls holds the reading open past the timeout.
    return await response.json().catch((error) => {
      if (error !== null && typeof error === 'object' && error.name === 'AbortError') {
        throw new ZhipuAccountError('timeout', `Zhipu body timed out after ${timeoutMs}ms`)
      }
      return undefined
    })
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Read one Zhipu account: plan windows when it has a plan, otherwise the cash
 * balance and the resource packages it does hold.
 *
 * A partial result still travels: an account whose plan endpoint is not
 * applicable is not a broken account. A round in which *nothing* could be read
 * throws instead, so a caller's cached reading survives rather than being
 * replaced by an empty one.
 *
 * @param {object} options
 * @param {string} options.providerId - the metered route, which picks the station.
 * @param {string|undefined} options.apiKey
 * @param {(url: string, init: object) => Promise<Response>} [options.fetchImpl]
 * @param {() => number} [options.now]
 * @param {number} [options.timeoutMs]
 * @returns {Promise<object>} the account snapshot.
 */
export async function fetchZhipuAccount({ providerId, apiKey, fetchImpl = globalThis.fetch, now = Date.now, timeoutMs = ZHIPU_TIMEOUT_MS }) {
  const host = hostForProvider(providerId)
  if (host === undefined) {
    throw new ZhipuAccountError('unsupported-provider', `no official Zhipu station serves the route "${String(providerId ?? '')}"`)
  }
  if (typeof apiKey !== 'string' || apiKey.length === 0) {
    throw new ZhipuAccountError('unconfigured', 'No Zhipu API key is configured')
  }
  const request = (path) => get({ host, path, apiKey, fetchImpl, timeoutMs, now })

  /** @type {Error[]} */
  const failures = []
  const attempt = (path) => request(path).catch((error) => {
    failures.push(error instanceof Error ? error : new Error(String(error)))
    return undefined
  })
  const [quotaBody, balanceBody, packageBody] = await Promise.all([
    attempt(ZHIPU_PATHS.quota),
    attempt(ZHIPU_PATHS.accountReport),
    attempt(`${ZHIPU_PATHS.tokenAccounts}?pageNum=1&pageSize=100`),
  ])
  const quota = quotaBody === undefined ? undefined : parseQuota(quotaBody)
  const balance = balanceBody === undefined ? undefined : parseAccountReport(balanceBody)
  const packages = packageBody === undefined ? [] : parseTokenAccounts(packageBody)

  const hasReading = (quota?.applicable === true && quota.windows.length > 0) || balance !== undefined || packages.length > 0
  if (!hasReading && failures.length > 0) {
    // Nothing at all could be read. That is a failed reading, not an empty
    // account, and it has to reach the caller as a failure so its own cached
    // reading survives instead of being replaced by an empty one.
    const first = failures[0]
    throw first instanceof ZhipuAccountError ? first : new ZhipuAccountError('error', first.message)
  }
  return {
    status: hasReading ? 'ok' : 'no-data',
    providerId,
    host,
    fetchedAt: now(),
    ...(quota === undefined ? {} : { plan: { applicable: quota.applicable, windows: quota.windows, reason: quota.reason } }),
    ...(balance === undefined ? {} : { balance }),
    packages,
    errors: failures.map((error) => (error instanceof ZhipuAccountError ? error.code : 'error')),
  }
}
