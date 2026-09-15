/**
 * Global model-call metering.
 *
 * The listener wraps DSH's `llm/stream` waterfall, forwards every chunk
 * untouched, and records one usage fact per completed call.  Two rules keep the
 * accounting honest:
 *
 * - a call is only recorded from the outermost metered stream, so a router
 *   provider that calls `ctx.llm.stream()` again does not bill the same tokens
 *   twice;
 * - a call that never reported usage records nothing.  Missing usage is not
 *   zero usage, and estimating it would invent money.
 *
 * @module dsh-provider-openai-subscription/usage/collector
 */

import { AsyncLocalStorage } from 'node:async_hooks'
import { METERED_PROVIDERS } from './types.js'

/** Marks the async context of a stream this meter already owns. */
const meteredDepth = new AsyncLocalStorage()

/** Monotonic per-process counter behind the default call identity. */
let callSequence = 0

/**
 * Opaque identity for one metered call, unique per process.
 * @returns {string}
 */
function createDefaultCallId() {
  callSequence += 1
  return `call-${process.pid.toString(36)}-${Date.now().toString(36)}-${callSequence.toString(36)}`
}

/**
 * Membership test for a fixed list of routes.
 * @param {readonly string[]} providers
 * @returns {(id: unknown) => boolean}
 */
function membership(providers) {
  const routes = new Set(providers)
  return (id) => routes.has(id)
}

/**
 * Create one `llm/stream` waterfall listener.
 * @param {object} options
 * @param {(fact: object) => void} options.record - receives each completed call.
 * @param {() => number} [options.now] - clock, injectable for tests.
 * @param {() => string} [options.createCallId] - opaque per-call identity.
 * @param {readonly string[]|((id: unknown) => boolean)} [options.providers] - routes
 *   to meter, either as a fixed list or as a live test. A test lets the host
 *   meter a provider that another plugin registered after this meter started.
 * @returns {(options: object, next: () => AsyncIterable<object>) => AsyncIterable<object>}
 */
export function createUsageCollector({ record, now = Date.now, createCallId = createDefaultCallId, providers = METERED_PROVIDERS }) {
  if (typeof record !== 'function') throw new TypeError('createUsageCollector requires record')
  const covers = typeof providers === 'function' ? providers : membership(providers)

  return (options, next) => {
    // Dispatch runs inside the marker as well: a router that starts another
    // ctx.llm.stream() while building the chain — not while pulling it — is the
    // same nested call, and metering it again would bill those tokens twice.
    const downstream = meteredDepth.run(true, () => next())
    // A nested call inside an already-metered stream belongs to the outer
    // record; wrapping it again would bill the same tokens twice.
    if (meteredDepth.getStore() !== undefined) return downstream
    const request = options === null || typeof options !== 'object' ? {} : options
    let metered = false
    try {
      metered = covers(request.provider) === true
    } catch {
      // A route test that fails is not a metering decision, and this listener
      // observes a model call: throwing here would fail the call itself.
      metered = false
    }
    if (!metered) return downstream

    const startedAt = now()
    const callId = createCallId()
    return (async function* meteredStream() {
      let usage = null
      const iterator = downstream[Symbol.asyncIterator]()
      let completed = false
      try {
        for (;;) {
          // Pull inside the depth marker so a downstream adapter that starts
          // another ctx.llm.stream() is recognised as nested.
          const result = await meteredDepth.run(true, () => iterator.next())
          if (result.done) break
          const chunk = result.value
          if (chunk !== null && typeof chunk === 'object' && chunk.type === 'usage' && chunk.usage != null) {
            usage = chunk.usage
          }
          yield chunk
        }
        completed = true
      } finally {
        // A consumer that stops early must still close the upstream stream.
        if (!completed) {
          try {
            await iterator.return?.()
          } catch {
            // The consumer already stopped caring; a failing teardown of an
            // abandoned stream cannot change the result it asked for.
          }
        }
        if (usage !== null) {
          try {
            record({
              callId,
              provider: request.provider,
              model: typeof request.model === 'string' ? request.model : '',
              ...(typeof request.sessionId === 'string' && request.sessionId.length > 0 ? { sessionId: request.sessionId } : {}),
              ...(typeof request.purpose === 'string' && request.purpose.length > 0 ? { purpose: request.purpose } : {}),
              startedAt,
              completedAt: now(),
              usage,
            })
          } catch {
            // Metering never fails a model call: the tokens are already spent.
          }
        }
      }
    })()
  }
}
