/**
 * OpenAI Subscription LLM adapter.
 *
 * Implements the DSH `LlmAdapter` duck type for the `openai-subscription`
 * provider route.  It streams ChatGPT Codex Responses via SSE and translates
 * events into DSH StreamChunks.
 *
 * @module dsh-provider-openai-subscription/provider/adapter
 */

import { PROVIDER_ID, USER_AGENT } from '../constants.js'
import { buildResponsesRequest } from './request-builder.js'
import { ResponsesEventTranslator } from './event-translator.js'
import { SseParser } from '../stream/sse-parser.js'
import { fetchModels } from '../models/client.js'

/** Upstream Responses endpoint. */
export const OPENAI_RESPONSES_URL = 'https://chatgpt.com/backend-api/codex/responses'

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
   */
  constructor({ getAccess, fetchImpl = fetch, timeoutMs = 120_000, defaultModel = '', reasoningEffort = '' }) {
    if (typeof getAccess !== 'function') throw new TypeError('OpenAISubscriptionAdapter requires getAccess')
    this.getAccess = getAccess
    this.fetchImpl = fetchImpl
    this.timeoutMs = timeoutMs
    this.defaultModel = defaultModel
    this.reasoningEffort = reasoningEffort
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

  /**
   * @param {string} provider
   * @returns {Promise<Array<{provider: string, id: string, name: string}>>}
   */
  async listModels(provider) {
    const models = await fetchModels({ getAccess: this.getAccess, fetchImpl: this.fetchImpl })
    return models.map((model) => ({ provider, id: model.id, name: model.name ?? model.id }))
  }

  /**
   * @param {string} provider
   * @param {string} model
   * @returns {Promise<{provider: string, id: string, name: string}>}
   */
  async resolveModel(provider, model) {
    return { provider, id: model, name: model }
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
          'user-agent': USER_AGENT,
          'content-type': 'application/json',
          accept: 'text/event-stream',
        },
        body: JSON.stringify(body),
        signal,
        redirect: 'error',
      })
    } catch (error) {
      throw new OpenAIProviderError('network', `OpenAI Responses request failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error })
    } finally {
      clearTimeout(timer)
    }
    if (response.status === 401 || response.status === 403) {
      throw new OpenAIProviderError('unauthorized', 'OpenAI subscription credential was rejected; sign in again')
    }
    if (!response.ok) {
      throw new OpenAIProviderError('upstream-error', `OpenAI Responses returned HTTP ${response.status}`)
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
