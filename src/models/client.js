/**
 * OpenAI Codex model catalog client and normalizer.
 *
 * @module dsh-provider-openai-subscription/models/client
 */

import { attributionHeaders } from '../provider/attribution.js'

/** Upstream model catalog endpoint (base; requires the client_version query). */
export const OPENAI_MODELS_URL = 'https://chatgpt.com/backend-api/codex/models'

/** client_version the endpoint requires; presence is validated, not the value. */
export const OPENAI_MODELS_CLIENT_VERSION = '1.0.0'

/** The full catalog URL. */
export function modelsCatalogUrl() {
  return `${OPENAI_MODELS_URL}?client_version=${encodeURIComponent(OPENAI_MODELS_CLIENT_VERSION)}`
}

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
 * Extract the catalog entries (`models`) from either response form.
 * @param {unknown} data
 * @returns {Array<Record<string, unknown>>|undefined}
 */
function catalogEntries(data) {
  if (Array.isArray(data)) return /** @type {Array<Record<string, unknown>>} */ (data)
  if (data !== null && typeof data === 'object' && Array.isArray(data.models)) {
    return /** @type {Array<Record<string, unknown>>} */ (data.models)
  }
  return undefined
}

/**
 * Normalize a model list response.
 *
 * The upstream shape is not treated as stable; this function only keeps
 * fields the DSH model directory can safely expose and drops unknown fields.
 * Both the object form (`{ models: [{ slug, display_name, ... }] }`) and the
 * bare array form (`[{ id, name }]`) are accepted.
 *
 * @param {unknown} data
 * @returns {Array<{id: string, name?: string}>}
 */
export function normalizeModels(data) {
  const list = catalogEntries(data)
  if (list === undefined) {
    throw new ModelClientError('malformed-models', 'Model catalog response is not an array')
  }
  const seen = new Set()
  const models = []
  for (const raw of list) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) continue
    const id = modelId(raw)
    if (id === undefined || seen.has(id)) continue
    seen.add(id)
    const name = typeof raw.display_name === 'string' && raw.display_name.length > 0
      ? raw.display_name
      : typeof raw.name === 'string' ? raw.name : undefined
    models.push({ id, ...(name === undefined ? {} : { name }) })
  }
  return models
}

/**
 * Normalize the full catalog for adapter metadata: id/name plus the context
 * window and reasoning-effort levels the provider discloses per model.
 *
 * @param {unknown} data
 * @returns {Array<{
 *   id: string, name?: string, description?: string,
 *   contextWindow?: number, maxContextWindow?: number,
 *   reasoning?: { efforts: Array<{id: string, name: string, description?: string}>, defaultEffort: string },
 * }>}
 */
export function normalizeModelCatalog(data) {
  const list = catalogEntries(data)
  if (list === undefined) {
    throw new ModelClientError('malformed-models', 'Model catalog response is not an array')
  }
  const seen = new Set()
  const models = []
  for (const raw of list) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) continue
    const id = modelId(raw)
    if (id === undefined || seen.has(id)) continue
    seen.add(id)
    const name = typeof raw.display_name === 'string' && raw.display_name.length > 0
      ? raw.display_name
      : typeof raw.name === 'string' ? raw.name : undefined
    const description = typeof raw.description === 'string' && raw.description.length > 0
      ? raw.description
      : undefined
    const levels = Array.isArray(raw.supported_reasoning_levels) ? raw.supported_reasoning_levels : []
    const efforts = levels.flatMap((level) => {
      if (level === null || typeof level !== 'object' || typeof level.effort !== 'string' || level.effort.length === 0) return []
      return [{
        id: level.effort,
        name: effortName(level.effort),
        ...(typeof level.description === 'string' && level.description.length > 0 ? { description: level.description } : {}),
      }]
    })
    const defaultReasoning = typeof raw.default_reasoning_level === 'string' ? raw.default_reasoning_level : undefined
    const contextWindow = typeof raw.context_window === 'number' && Number.isFinite(raw.context_window)
      ? raw.context_window
      : undefined
    const maxContextWindow = typeof raw.max_context_window === 'number' && Number.isFinite(raw.max_context_window)
      ? raw.max_context_window
      : undefined
    models.push({
      id,
      ...(name === undefined ? {} : { name }),
      ...(description === undefined ? {} : { description }),
      ...(contextWindow === undefined ? {} : { contextWindow }),
      ...(maxContextWindow === undefined ? {} : { maxContextWindow }),
      ...(efforts.length === 0 ? {} : {
        reasoning: { efforts, ...(defaultReasoning === undefined ? {} : { defaultEffort: defaultReasoning }) },
      }),
    })
  }
  return models
}

/** The stable model id from a raw catalog entry. */
function modelId(raw) {
  if (typeof raw.slug === 'string' && raw.slug.length > 0) return raw.slug
  if (typeof raw.id === 'string' && raw.id.length > 0) return raw.id
  return undefined
}

/** Display name for a reasoning effort level. */
function effortName(effort) {
  const names = { low: 'Low', medium: 'Medium', high: 'High', xhigh: 'XHigh', max: 'Max', ultra: 'Ultra' }
  return names[effort] ?? effort
}

/**
 * Fetch one parsed catalog response (shared request path for both normalizers).
 * @param {object} options
 * @param {() => Promise<{accessToken: string, accountId: string}>} options.getAccess
 * @param {(url: string, init: RequestInit) => Promise<Response>} [options.fetchImpl]
 * @param {number} [options.timeoutMs]
 * @param {AbortSignal} [options.signal] - caller cancellation, honored alongside the timeout.
 * @returns {Promise<unknown>}
 */
async function fetchCatalogData({ getAccess, fetchImpl = fetch, timeoutMs = 30_000, signal }) {
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
  // The caller's cancellation and this request's own timeout both have to end
  // the request, so neither replaces the other.
  const requestSignal = signal === undefined ? controller.signal : AbortSignal.any([signal, controller.signal])
  const attribution = await attributionHeaders()
  let response
  try {
    response = await fetchImpl(modelsCatalogUrl(), {
      method: 'GET',
      headers: {
        authorization: `Bearer ${access.accessToken}`,
        'chatgpt-account-id': access.accountId,
        ...attribution,
        accept: 'application/json',
      },
      signal: requestSignal,
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
  return data
}

/**
 * Fetch the model catalog (directory shape only).
 * @param {object} options
 * @param {() => Promise<{accessToken: string, accountId: string}>} options.getAccess
 * @param {(url: string, init: RequestInit) => Promise<Response>} [options.fetchImpl]
 * @param {number} [options.timeoutMs]
 * @returns {Promise<Array<{id: string, name?: string}>>}
 */
export async function fetchModels(options) {
  return normalizeModels(await fetchCatalogData(options))
}

/**
 * Fetch the full model catalog (adapter metadata with reasoning and context).
 * @param {object} options
 * @param {() => Promise<{accessToken: string, accountId: string}>} options.getAccess
 * @param {(url: string, init: RequestInit) => Promise<Response>} [options.fetchImpl]
 * @param {number} [options.timeoutMs]
 * @returns {Promise<ReturnType<typeof normalizeModelCatalog>>}
 */
export async function fetchModelCatalog(options) {
  return normalizeModelCatalog(await fetchCatalogData(options))
}
