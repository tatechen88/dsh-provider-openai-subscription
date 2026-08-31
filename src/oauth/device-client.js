/**
 * OpenAI device-code OAuth client.
 *
 * Implements the device authorization flow used by ChatGPT/Codex: the user
 * opens a verification page and enters a code, then this client polls until
 * an authorization code + PKCE verifier are issued.
 *
 * @module dsh-provider-openai-subscription/oauth/device-client
 */

/** Device authorization start endpoint. */
export const DEVICE_USER_CODE_URL = 'https://auth.openai.com/api/accounts/deviceauth/usercode'
/** Device authorization poll endpoint. */
export const DEVICE_TOKEN_URL = 'https://auth.openai.com/api/accounts/deviceauth/token'
/** Human-facing verification page. */
export const DEVICE_VERIFICATION_URI = 'https://auth.openai.com/codex/device'
/** Redirect URI used when exchanging the device-issued code. */
export const DEVICE_REDIRECT_URI = 'https://auth.openai.com/deviceauth/callback'

/** Default device flow timeout. */
export const DEVICE_CODE_TIMEOUT_SECONDS = 300
/** RFC 8628 default poll interval. */
export const DEFAULT_POLL_INTERVAL_SECONDS = 5
/** Minimum poll interval in ms. */
export const MIN_POLL_INTERVAL_MS = 1000
/** slow_down increment in ms. */
export const SLOW_DOWN_INCREMENT_MS = 5000

/** Stable device flow error. */
export class DeviceFlowError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   * @param {ErrorOptions} [options]
   */
  constructor(code, message, options) {
    super(message, options)
    this.name = 'DeviceFlowError'
    this.code = code
  }
}

/**
 * Start a device authorization request.
 * @param {object} options
 * @param {string} options.clientId
 * @param {(url: string, init: RequestInit) => Promise<Response>} [options.fetchImpl]
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<{deviceAuthId: string, userCode: string, intervalSeconds: number}>}
 */
export async function startDeviceAuth({ clientId, fetchImpl = fetch, signal }) {
  let response
  try {
    response = await fetchImpl(DEVICE_USER_CODE_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ client_id: clientId }),
      signal,
      redirect: 'error',
    })
  } catch (error) {
    throw new DeviceFlowError('network', `Device authorization request failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error })
  }
  const text = await response.text()
  let data
  try {
    data = JSON.parse(text)
  } catch {
    throw new DeviceFlowError('invalid-json', `Device authorization returned non-JSON (HTTP ${response.status})`)
  }
  if (!response.ok) {
    if (response.status === 404) {
      throw new DeviceFlowError('not-enabled', 'Device code login is not enabled; use browser login')
    }
    throw new DeviceFlowError('start-failed', `Device authorization returned HTTP ${response.status}`)
  }
  const device = data
  const interval = typeof device?.interval === 'string' ? Number(device.interval.trim()) : device?.interval
  if (typeof device?.device_auth_id !== 'string' || typeof device?.user_code !== 'string'
    || typeof interval !== 'number' || !Number.isFinite(interval) || interval < 0) {
    throw new DeviceFlowError('malformed-start', 'Device authorization response is malformed')
  }
  return { deviceAuthId: device.device_auth_id, userCode: device.user_code, intervalSeconds: interval }
}

/**
 * Poll a device authorization until it completes.
 * @param {object} options
 * @param {{deviceAuthId: string, userCode: string, intervalSeconds: number}} options.device
 * @param {(url: string, init: RequestInit) => Promise<Response>} [options.fetchImpl]
 * @param {AbortSignal} [options.signal]
 * @param {number} [options.timeoutSeconds]
 * @returns {Promise<{authorizationCode: string, codeVerifier: string}>}
 */
export async function pollDeviceAuth({ device, fetchImpl = fetch, signal, timeoutSeconds = DEVICE_CODE_TIMEOUT_SECONDS }) {
  const deadline = Date.now() + timeoutSeconds * 1000
  let intervalMs = Math.max(MIN_POLL_INTERVAL_MS, Math.floor(device.intervalSeconds * 1000))
  let slowDownResponses = 0
  while (Date.now() < deadline) {
    if (signal?.aborted) throw new DeviceFlowError('cancelled', 'Device authorization was cancelled')
    const result = await pollOnce(device, fetchImpl, signal)
    if (result.status === 'complete') return result.value
    if (result.status === 'failed') throw new DeviceFlowError('failed', result.message)
    if (result.status === 'slow_down') {
      slowDownResponses += 1
      intervalMs = result.intervalSeconds !== undefined
        ? Math.max(MIN_POLL_INTERVAL_MS, Math.floor(result.intervalSeconds * 1000))
        : intervalMs + SLOW_DOWN_INCREMENT_MS
    }
    const remaining = deadline - Date.now()
    if (remaining <= 0) break
    await abortableSleep(Math.min(intervalMs, remaining), signal)
  }
  throw new DeviceFlowError(slowDownResponses > 0 ? 'slow-down-timeout' : 'timed-out', 'Device authorization timed out')
}

/**
 * One poll request.
 * @param {{deviceAuthId: string, userCode: string}} device
 * @param {(url: string, init: RequestInit) => Promise<Response>} fetchImpl
 * @param {AbortSignal|undefined} signal
 * @returns {Promise<{status: 'complete', value: {authorizationCode: string, codeVerifier: string}}|{status: 'pending'|'slow_down'|'failed', message?: string, intervalSeconds?: number}>}
 */
async function pollOnce(device, fetchImpl, signal) {
  let response
  try {
    response = await fetchImpl(DEVICE_TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ device_auth_id: device.deviceAuthId, user_code: device.userCode }),
      signal,
      redirect: 'error',
    })
  } catch (error) {
    return { status: 'failed', message: `Device poll request failed: ${error instanceof Error ? error.message : String(error)}` }
  }
  const text = await response.text()
  let data
  try {
    data = JSON.parse(text)
  } catch {
    return { status: 'failed', message: `Device poll returned non-JSON (HTTP ${response.status})` }
  }
  if (response.ok) {
    if (typeof data?.authorization_code === 'string' && typeof data?.code_verifier === 'string') {
      return { status: 'complete', value: { authorizationCode: data.authorization_code, codeVerifier: data.code_verifier } }
    }
    return { status: 'failed', message: 'Device poll response is malformed' }
  }
  if (response.status === 403 || response.status === 404) return { status: 'pending' }
  const error = data?.error
  const errorCode = error !== null && typeof error === 'object' ? error.code : error
  if (errorCode === 'deviceauth_authorization_pending') return { status: 'pending' }
  if (errorCode === 'slow_down') {
    const interval = data?.interval
    const intervalSeconds = typeof interval === 'string' ? Number(interval.trim()) : interval
    return { status: 'slow_down', ...(typeof intervalSeconds === 'number' && Number.isFinite(intervalSeconds) ? { intervalSeconds } : {}) }
  }
  return { status: 'failed', message: `Device poll failed with HTTP ${response.status}` }
}

/**
 * Sleep that aborts on signal.
 * @param {number} ms
 * @param {AbortSignal|undefined} signal
 * @returns {Promise<void>}
 */
function abortableSleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DeviceFlowError('cancelled', 'Device authorization was cancelled'))
      return
    }
    const onAbort = () => {
      clearTimeout(timer)
      reject(new DeviceFlowError('cancelled', 'Device authorization was cancelled'))
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}
