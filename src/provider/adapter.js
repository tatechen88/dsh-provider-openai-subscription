/**
 * OpenAI Subscription LLM adapter.
 *
 * Implements the DSH `LlmAdapter` duck type for the `openai-subscription`
 * provider route.  It streams ChatGPT Codex Responses via SSE and translates
 * events into DSH StreamChunks.
 *
 * @module dsh-provider-openai-subscription/provider/adapter
 */

import { PROVIDER_ID } from '../constants.js'
import { translatorFor } from '../i18n.js'
import { attributionHeaders } from './attribution.js'
import { buildResponsesRequest } from './request-builder.js'
import { ResponsesEventTranslator } from './event-translator.js'
import { SseParser } from '../stream/sse-parser.js'
import { fetchModelCatalog } from '../models/client.js'

/** Upstream Responses endpoint. */
export const OPENAI_RESPONSES_URL = 'https://chatgpt.com/backend-api/codex/responses'

/**
 * How long a fetched model catalogue is reused.
 *
 * The vendor ships models between releases of this plugin, so the catalogue has
 * to expire on its own: a list cached for the life of the process would keep a
 * new model out of the picker until DSH restarted.
 */
export const MODEL_CATALOG_TTL_MS = 10 * 60 * 1000

/** Stable adapter error. */
export class OpenAIProviderError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   * @param {ErrorOptions} [options]
   */
  constructor(code, message, options) {
    super(message, options)
    this.name = 'OpenAIProviderError'
    this.code = code
  }
}

/**
 * Describe a subscription usage limit, or nothing when this is a different failure.
 *
 * The vendor answers an exhausted window with a compact JSON body that says
 * which window, how long until it resets, and when that is. Reporting it as
 * "HTTP 429: {…}" plus the whole request buries all three under the least useful
 * part of the message — the user needs to know whether to switch model for five
 * minutes or five days.
 *
 * @param {string} detail - the response body as read.
 * @param {(key: string, params?: Record<string, string|number>) => string} t - translator.
 * @returns {string|undefined} a sentence for the human, when this is that error.
 */
function describeUsageLimit(detail, t) {
  let parsed
  try {
    parsed = JSON.parse(detail)
  } catch {
    return undefined
  }
  const error = parsed?.error
  if (error === null || typeof error !== 'object') return undefined
  if (error.type !== 'usage_limit_reached' && typeof error.resets_in_seconds !== 'number') return undefined

  const windowMinutes = typeof error.limit_window_minutes === 'number' ? error.limit_window_minutes : undefined
  // "usage" for a body that names no window: the sentence still says something.
  const window = windowMinutes === undefined ? 'usage' : t('adapter.error.usage-limit.window', { hours: String(Math.round(windowMinutes / 60)) })
  const plan = typeof error.plan_type === 'string' && error.plan_type.length > 0 ? t('adapter.error.usage-limit.plan', { plan: error.plan_type }) : ''

  const seconds = typeof error.resets_in_seconds === 'number' ? error.resets_in_seconds : undefined
  const at = typeof error.resets_at === 'number' ? new Date(error.resets_at * 1000) : undefined
  const when = []
  if (seconds !== undefined && seconds > 0) when.push(t('adapter.error.usage-limit.resets-in', { minutes: String(Math.max(1, Math.round(seconds / 60))) }))
  else if (at !== undefined) when.push(t('adapter.error.usage-limit.already-reset'))
  else when.push(t('adapter.error.usage-limit.unreported'))
  if (at !== undefined && !Number.isNaN(at.getTime())) when.push(t('adapter.error.usage-limit.at', { time: at.toLocaleTimeString() }))

  return t('adapter.error.usage-limit', {
    window,
    plan,
    timing: when.join(' '),
  })
}

/**
 * Adapter for DSH `ctx.llm.registerAdapter()`.
 */
export class OpenAISubscriptionAdapter {
  /**
   * @param {object} options
   * @param {() => Promise<{accessToken: string, accountId: string}>} options.getAccess
   * @param {(url: string, init: RequestInit) => Promise<Response>} [options.fetchImpl]
   * @param {number} [options.timeoutMs] - whole-request deadline: response
   *   headers plus the entire SSE body. Defaults to 5 minutes; the old 2-minute
   *   default aborted slow-but-healthy generations whenever the upstream was
   *   congested.
   * @param {string} [options.defaultModel]
   * @param {string} [options.reasoningEffort]
   * @param {() => number} [options.now]
   * @param {(key: string, params?: Record<string, string|number>) => string} [options.t] -
   *   translator for the sentences a person reads; English by default, because a
   *   test or a headless caller has no language to follow.
   */
  constructor({ getAccess, fetchImpl = fetch, timeoutMs = 300_000, defaultModel = '', reasoningEffort = '', now = Date.now, t = translatorFor('en') }) {
    if (typeof getAccess !== 'function') throw new TypeError('OpenAISubscriptionAdapter requires getAccess')
    this.getAccess = getAccess
    this.fetchImpl = fetchImpl
    this.timeoutMs = timeoutMs
    this.defaultModel = defaultModel
    this.reasoningEffort = reasoningEffort
    this.now = now
    this.t = t
    /** @type {Array<{id: string, name?: string, description?: string, contextWindow?: number, maxContextWindow?: number, reasoning?: object}>|undefined} */
    this.catalog = undefined
    this.catalogAt = 0
  }

  /**
   * Drop the cached catalogue, so the next listing reads the vendor again.
   * @returns {void}
   */
  invalidateCatalog() {
    this.catalog = undefined
    this.catalogAt = 0
  }

  /**
   * Adopt settings a running deployment changed without remounting this plugin.
   *
   * These three fields are the ones the Config schema marks volatile, so DSH
   * pushes edits to them into the live config object and tells the plugin to
   * re-read. An adapter that kept its constructor copy would silently ignore
   * what the settings page shows.
   *
   * @param {{defaultModel?: string, reasoningEffort?: string, streamTimeoutMs?: number}} next
   * @returns {void}
   */
  setDefaults(next) {
    if (typeof next?.defaultModel === 'string') this.defaultModel = next.defaultModel
    if (typeof next?.reasoningEffort === 'string') this.reasoningEffort = next.reasoningEffort
    // Only a finite value at or above the floor is adopted; anything else keeps
    // the current deadline instead of trading one bad setting for a hang.
    const timeout = next?.streamTimeoutMs
    if (typeof timeout === 'number' && Number.isFinite(timeout) && timeout >= 1_000) this.timeoutMs = timeout
  }

  /**
   * @param {string} provider
   * @returns {{id: string, name: string}}
   */
  providerInfo(provider) {
    return { id: provider, name: 'OpenAI (ChatGPT OAuth)' }
  }

  /**
   * No provider-specific retry policy; DSH defaults apply.
   * @returns {undefined}
   */
  providerRetryPolicy() {
    return undefined
  }

  /** Fetch (and cache) the full catalog, including reasoning/context metadata. */
  async #catalog(signal) {
    // A cancelled read must not replace the cached catalog, so the fetch result
    // is only adopted after it resolves — and the freshness stamp is taken
    // *then*, because stamping the moment the read started lets a slow fetch
    // burn its own TTL.
    if (this.catalog === undefined || this.now() - this.catalogAt >= MODEL_CATALOG_TTL_MS) {
      const catalog = await fetchModelCatalog({ getAccess: this.getAccess, fetchImpl: this.fetchImpl, signal })
      this.catalog = catalog
      this.catalogAt = this.now()
    }
    return this.catalog
  }

  /**
   * Probe this route for the models it advertises, for DSH's model-discovery
   * seam. The endpoint needs an authenticated read, so a caller that is not
   * signed in gets the credential error rather than an empty list.
   *
   * `maxTokens` is deliberately never reported: the Codex endpoint rejects an
   * output cap, so advertising one would promise a control this route drops.
   *
   * @param {AbortSignal} [signal] - caller cancellation.
   * @returns {Promise<Array<{id: string, name: string, contextWindow?: number}>>}
   */
  async discoverModels(signal) {
    const catalog = await this.#catalog(signal)
    return catalog.map((model) => ({
      id: model.id,
      name: model.name ?? model.id,
      ...(model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow }),
    }))
  }

  /**
   * @param {string} provider
   * @returns {Promise<Array<{provider: string, id: string, name: string}>>}
   */
  async listModels(provider) {
    const catalog = await this.#catalog()
    return catalog.map((model) => ({ provider, id: model.id, name: model.name ?? model.id }))
  }

  /**
   * @param {string} provider
   * @param {string} model
   * @param {AbortSignal} [signal]
   * @returns {Promise<{provider: string, id: string, name: string, inputModalities?: string[], context?: {contextWindow: number}, reasoning?: {efforts: Array<{id: string, name: string, description?: string}>, defaultEffort?: string}}>}
   */
  async resolveModel(provider, model, signal) {
    const catalog = await this.#catalog(signal)
    const entry = catalog.find((candidate) => candidate.id === model)
    if (entry === undefined) return { provider, id: model, name: model }
    return {
      provider,
      id: entry.id,
      name: entry.name ?? entry.id,
      inputModalities: ['text'],
      ...(entry.contextWindow === undefined ? {} : { context: { contextWindow: entry.contextWindow } }),
      ...(entry.reasoning === undefined ? {} : { reasoning: entry.reasoning }),
    }
  }

  /**
   * Bind model metadata and dispatch to this adapter's stream.
   * @param {string} provider
   * @param {string} model
   * @param {AbortSignal} [signal]
   * @returns {Promise<{model: {provider: string, id: string, name: string}, stream: (options: object) => AsyncGenerator<Record<string, unknown>, void, void>}>}
   */
  async prepareCall(provider, model, signal) {
    return {
      model: await this.resolveModel(provider, model, signal),
      stream: (options) => this.stream(options),
    }
  }

  /**
   * Stream one model call.
   * @param {object} options - GenerateOptions.
   * @returns {AsyncGenerator<Record<string, unknown>, void, void>}
   */
  async *stream(options) {
    const access = await this.getAccess()
    const body = buildResponsesRequest({
      model: options.model || this.defaultModel,
      system: options.system,
      messages: options.messages,
      tools: options.tools,
      maxTokens: options.maxTokens,
      reasoningEffort: options.reasoningEffort || this.reasoningEffort,
      stream: true,
    })
    const bodyJson = JSON.stringify(body)
    const attribution = await attributionHeaders()
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    timer.unref?.()
    const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal
    let response
    try {
      response = await this.fetchImpl(OPENAI_RESPONSES_URL, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${access.accessToken}`,
          'chatgpt-account-id': access.accountId,
          ...attribution,
          'content-type': 'application/json',
          accept: 'text/event-stream',
        },
        body: bodyJson,
        signal,
        redirect: 'error',
      })
    } catch (error) {
      throw new OpenAIProviderError('network', this.t('adapter.error.network', { message: error instanceof Error ? error.message : String(error) }), { cause: error })
    }
    // The deadline is NOT cleared here: it covers the SSE body too. Clearing it
    // when the headers arrived left a stalled mid-stream connection hanging
    // until the consumer gave up, which for an agent loop is never.
    if (response.status === 401 || response.status === 403) {
      throw new OpenAIProviderError('unauthorized', this.t('adapter.error.unauthorized', { status: String(response.status) }))
    }
    if (!response.ok) {
      let detail = ''
      try {
        detail = (await response.text()).slice(0, 500)
      } catch {
        // a stream teardown race; the status alone still identifies the failure
      }
      // An exhausted subscription window is not a malformed request, so the
      // request dump that helps diagnose one would only bury the answer here.
      const limit = response.status === 429 ? describeUsageLimit(detail, this.t) : undefined
      if (limit !== undefined) throw new OpenAIProviderError('usage-limit-reached', limit)
      throw new OpenAIProviderError('upstream-error', this.t('adapter.error.upstream', {
        status: String(response.status),
        detail: detail.length > 0 ? `: ${detail}` : '',
        request: bodyJson.slice(0, 800),
      }))
    }

    const parser = new SseParser()
    const translator = new ResponsesEventTranslator()
    const reader = response.body?.getReader()
    if (reader === undefined) throw new OpenAIProviderError('empty-body', this.t('adapter.error.empty-body'))
    let completed = false
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        for (const event of parser.push(value)) {
          if (event.data === '[DONE]') continue
          let data
          try {
            data = JSON.parse(event.data)
          } catch {
            continue
          }
          for (const chunk of translator.push(data)) yield chunk
        }
      }
      for (const event of parser.end()) {
        if (event.data === '[DONE]') continue
        try {
          const data = JSON.parse(event.data)
          for (const chunk of translator.push(data)) yield chunk
        } catch {
          // trailing partial event
        }
      }
      for (const chunk of translator.end()) yield chunk
      completed = true
    } finally {
      // The read is over, one way or another: stop the deadline, and close the
      // upstream body when the consumer walked away early — releasing the lock
      // alone keeps the socket open until the server tires of it.
      clearTimeout(timer)
      if (!completed) {
        await reader.cancel().catch(() => {
          // The consumer already stopped caring; a failing teardown of an
          // abandoned stream cannot change the result it asked for.
        })
      }
      reader.releaseLock?.()
    }
  }
}
