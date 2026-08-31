/**
 * OpenAI Codex model catalog client and normalizer.
 *
 * @module dsh-provider-openai-subscription/models/client
 */

/** Upstream model catalog endpoint. */
export const OPENAI_MODELS_URL = 'https://chatgpt.com/backend-api/codex/models'

/** Stable model client error. */
export class ModelClientError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   * @param {ErrorOptions} [options]
   */
  constructor(code, message, options) {
    super(message, options)
    this.name = 'ModelClientError'
    this.code = code
  }
}

/**
 * Normalize a model list response.
 *
 * The upstream shape is not treated as stable; this function only keeps
 * fields the DSH model directory can safely expose and drops unknown fields.
 *
 * @param {unknown} data
 * @returns {Array<{id: string, name?: string}>}
 */
export function normalizeModels(data) {
  if (!Array.isArray(data)) {
    throw new ModelClientError('malformed-models', 'Model catalog response is not an array')
  }
  const seen = new Set()
  const models = []
  for (const raw of data) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) continue
    const id = raw.id
    if (typeof id !== 'string' || id.length === 0 || seen.has(id)) continue
    seen.add(id)
    const name = raw.name
    models.push({ id, ...(typeof name === 'string' && name.length > 0 ? { name } : {}) })
  }
  return models
}

/**
 * Fetch the model catalog.
 * @param {object} options
 * @param {() => Promise<{accessToken: string, accountId: string}>} options.getAccess
 * @param {(url: string, init: RequestInit) => Promise<Response>} [options.fetchImpl]
 * @param {number} [options.timeoutMs]
 * @returns {Promise<Array<{id: string, name?: string}>>}
 */
export async function fetchModels({ getAccess, fetchImpl = fetch, timeoutMs = 30_000 }) {
  let access
  try {
    access = await getAccess()
  } catch (error) {
    const code = /** @type {{code?: string}} */ (error).code
    if (code === 'not-signed-in') throw new ModelClientError('not-signed-in', 'OpenAI subscription is not signed in')
    if (code === 'reauth-required') throw new ModelClientError('reauth-required', 'OpenAI subscription requires reauthentication')
    throw new ModelClientError('credential', 'Unable to read OpenAI subscription credentials', { cause: error })
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  timer.unref?.()
  let response
  try {
    response = await fetchImpl(OPENAI_MODELS_URL, {
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
    throw new ModelClientError('network', `Model catalog request failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error })
  } finally {
    clearTimeout(timer)
  }
  const text = await response.text()
  let data
  try {
    data = JSON.parse(text)
  } catch {
    throw new ModelClientError('invalid-json', `Model catalog returned non-JSON (HTTP ${response.status})`)
  }
  if (response.status === 401 || response.status === 403) {
    throw new ModelClientError('unauthorized', 'OpenAI subscription credential was rejected; sign in again')
  }
  if (!response.ok) {
    throw new ModelClientError('upstream-error', `Model catalog returned HTTP ${response.status}`)
  }
  return normalizeModels(data)
}
