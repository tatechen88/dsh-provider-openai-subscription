/**
 * Usage domain model for the built-in OpenAI / DeepSeek meter.
 *
 * One UsageFact describes a single billed model call: which route served it,
 * which session asked for it, when it started, and the provider-reported token
 * buckets.  Every field here is JSON-safe because facts are persisted and sent
 * to the browser; nothing in this module retains a live DSH object.
 *
 * @module dsh-provider-openai-subscription/usage/types
 */

/** Provider routes this meter records. Every other route is passed through. */
export const METERED_PROVIDERS = Object.freeze(['openai-subscription', 'deepseek-official'])

/** Token buckets summed for display; reasoning is a subset of output. */
export const USAGE_BUCKETS = Object.freeze(['inputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'outputTokens'])

/** Stable usage-model error. */
export class UsageFactError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   */
  constructor(code, message) {
    super(message)
    this.name = 'UsageFactError'
    this.code = code
  }
}

/**
 * Whether one wire counter is a usable token count.
 * @param {unknown} value
 * @returns {boolean}
 */
export function isTokenCount(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

/**
 * Zero-valued bucket record.
 * @returns {{inputTokens: number, cacheReadTokens: number, cacheWriteTokens: number, outputTokens: number}}
 */
export function emptyBuckets() {
  return { inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 }
}

/**
 * Add two bucket records.
 * @param {object} left
 * @param {object} right
 * @returns {{inputTokens: number, cacheReadTokens: number, cacheWriteTokens: number, outputTokens: number}}
 */
export function addBuckets(left, right) {
  return {
    inputTokens: left.inputTokens + right.inputTokens,
    cacheReadTokens: left.cacheReadTokens + right.cacheReadTokens,
    cacheWriteTokens: left.cacheWriteTokens + right.cacheWriteTokens,
    outputTokens: left.outputTokens + right.outputTokens,
  }
}

/**
 * Extract the four disjoint buckets from a provider usage record. Optional
 * buckets default to zero because a provider that reports nothing about caching
 * is not the same as one reporting a cache miss — the distinction is preserved
 * as "reported", not as a fabricated zero.
 * @param {unknown} usage - DSH TokenUsage-shaped record.
 * @returns {{ok: true, buckets: object, report: object}|{ok: false, reason: string}}
 */
export function readUsageBuckets(usage) {
  if (usage === null || typeof usage !== 'object' || Array.isArray(usage)) {
    return { ok: false, reason: 'usage-not-object' }
  }
  const record = /** @type {Record<string, unknown>} */ (usage)
  if (!isTokenCount(record.inputTokens) || !isTokenCount(record.outputTokens)) {
    return { ok: false, reason: 'usage-missing-aggregates' }
  }
  const cacheReadTokens = isTokenCount(record.cacheReadTokens) ? record.cacheReadTokens : 0
  const cacheWriteTokens = isTokenCount(record.cacheWriteTokens) ? record.cacheWriteTokens : 0
  const reasoningTokens = isTokenCount(record.reasoningTokens) ? record.reasoningTokens : undefined
  return {
    ok: true,
    buckets: {
      inputTokens: record.inputTokens,
      cacheReadTokens,
      cacheWriteTokens,
      outputTokens: record.outputTokens,
    },
    report: {
      cacheReadReported: isTokenCount(record.cacheReadTokens),
      cacheWriteReported: isTokenCount(record.cacheWriteTokens),
      ...(reasoningTokens === undefined ? {} : { reasoningTokens }),
    },
  }
}

/**
 * Validate one usage fact without trusting its producer.
 * @param {unknown} value
 * @returns {{ok: true, fact: object}|{ok: false, errors: string[]}}
 */
export function validateUsageFact(value) {
  const errors = []
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, errors: ['fact-not-object'] }
  }
  const record = /** @type {Record<string, unknown>} */ (value)
  if (typeof record.callId !== 'string' || record.callId.length === 0) errors.push('callId')
  if (typeof record.provider !== 'string' || record.provider.length === 0) errors.push('provider')
  if (typeof record.model !== 'string' || record.model.length === 0) errors.push('model')
  if (record.sessionId !== undefined && typeof record.sessionId !== 'string') errors.push('sessionId')
  if (record.purpose !== undefined && typeof record.purpose !== 'string') errors.push('purpose')
  if (!isTokenCount(record.startedAt)) errors.push('startedAt')
  if (!isTokenCount(record.completedAt)) errors.push('completedAt')
  const buckets = readUsageBuckets(record.usage)
  if (!buckets.ok) errors.push(buckets.reason)
  if (errors.length > 0) return { ok: false, errors }
  return {
    ok: true,
    fact: {
      callId: record.callId,
      provider: record.provider,
      model: record.model,
      ...(record.sessionId === undefined ? {} : { sessionId: record.sessionId }),
      ...(record.purpose === undefined ? {} : { purpose: record.purpose }),
      startedAt: record.startedAt,
      completedAt: record.completedAt,
      usage: {
        ...buckets.buckets,
        ...(buckets.report.reasoningTokens === undefined ? {} : { reasoningTokens: buckets.report.reasoningTokens }),
        cacheReadReported: buckets.report.cacheReadReported,
        cacheWriteReported: buckets.report.cacheWriteReported,
      },
    },
  }
}

/**
 * Validate one usage fact, throwing on the first invalid contract.
 * @param {unknown} value
 * @returns {object} the validated fact.
 */
export function assertUsageFact(value) {
  const result = validateUsageFact(value)
  if (!result.ok) {
    throw new UsageFactError('invalid-fact', `UsageFact is invalid: ${result.errors.join(', ')}`)
  }
  return result.fact
}

/**
 * Total prompt-side tokens of one fact, including cache traffic.
 * @param {object} usage
 * @returns {number}
 */
export function promptTokensOf(usage) {
  return usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens
}

/**
 * Cache hit ratio over the prompt side, or null when nothing was reported.
 * @param {object} usage
 * @returns {number|null} ratio in [0, 1].
 */
export function cacheHitRatio(usage) {
  const prompt = promptTokensOf(usage)
  if (prompt <= 0) return null
  return usage.cacheReadTokens / prompt
}
