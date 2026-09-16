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
 * Adapter for DSH `ctx.llm.registerAdapter()`.
 */
export class OpenAISubscriptionAdapter {
  /**
   * @param {object} options
   * @param {() => Promise<{accessToken: string, accountId: string}>} options.getAccess
   * @param {(url: string, init: RequestInit) => Promise<Response>} [options.fetchImpl]
   * @param {number} [options.timeoutMs]
   * @param {string} [options.defaultModel]
   * @param {string} [options.reasoningEffort]
   * @param {() => number} [options.now]
   */
  constructor({ getAccess, fetchImpl = fetch, timeoutMs = 120_000, defaultModel = '', reasoningEffort = '', now = Date.now }) {
    if (typeof getAccess !== 'function') throw new TypeError('OpenAISubscriptionAdapter requires getAccess')
    this.getAccess = getAccess
    this.fetchImpl = fetchImpl
    this.timeoutMs = timeoutMs
    this.defaultModel = defaultModel
    this.reasoningEffort = reasoningEffort
    this.now = now
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
    const now = this.now()
    if (this.catalog === undefined || now - this.catalogAt >= MODEL_CATALOG_TTL_MS) {
      // A cancelled read must not replace the cached catalog, so the fetch
      // result is only adopted after it resolves.
      const catalog = await fetchModelCatalog({ getAccess: this.getAccess, fetchImpl: this.fetchImpl, signal })
      this.catalog = catalog
      this.catalogAt = now
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
      throw new OpenAIProviderError('network', `OpenAI Responses request failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error })
    } finally {
      clearTimeout(timer)
    }
    if (response.status === 401 || response.status === 403) {
      throw new OpenAIProviderError('unauthorized', `OpenAI subscription credential was rejected; sign in again (HTTP ${response.status})`)
    }
    if (!response.ok) {
      let detail = ''
      try {
        detail = (await response.text()).slice(0, 500)
      } catch {
        // a stream teardown race; the status alone still identifies the failure
      }
      throw new OpenAIProviderError('upstream-error', `OpenAI Responses returned HTTP ${response.status}${detail.length > 0 ? `: ${detail}` : ''} | request: ${bodyJson.slice(0, 800)}`)
    }

    const parser = new SseParser()
    const translator = new ResponsesEventTranslator()
    const reader = response.body?.getReader()
    if (reader === undefined) throw new OpenAIProviderError('empty-body', 'OpenAI Responses returned no body')
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
    } finally {
      reader.releaseLock?.()
    }
  }
}
