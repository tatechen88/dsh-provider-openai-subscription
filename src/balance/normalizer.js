/**
 * Balance/usage response normalization.
 *
 * The upstream `wham/usage` endpoint is not a stable public API.  This module
 * is the only place that interprets its shape; every other layer consumes the
 * normalized snapshot.
 *
 * @module dsh-provider-openai-subscription/balance/normalizer
 */

/** Stable balance normalizer error. */
export class BalanceSchemaError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   */
  constructor(code, message) {
    super(message)
    this.name = 'BalanceSchemaError'
    this.code = code
  }
}

/**
 * Normalize one raw window object.
 * @param {unknown} raw
 * @param {string} fallbackId
 * @param {string} fallbackLabel
 * @returns {{id: string, label: string, usedPercent: number, remainingPercent: number, windowSeconds?: number, resetsAt?: number, resetAfterSeconds?: number, exhausted: boolean}}
 */
function normalizeWindow(raw, fallbackId, fallbackLabel, now = Date.now) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new BalanceSchemaError('malformed-window', 'Balance window is malformed')
  }
  const record = /** @type {Record<string, unknown>} */ (raw)
  const usedPercent = record.used_percent
  if (typeof usedPercent !== 'number' || !Number.isFinite(usedPercent)) {
    throw new BalanceSchemaError('malformed-used-percent', 'Balance window used_percent is malformed')
  }
  const boundedUsed = Math.min(100, Math.max(0, usedPercent))
  const windowSeconds = record.limit_window_seconds
  const resetAfterSeconds = record.reset_after_seconds
  const resetAt = record.reset_at
  // reset_at is an epoch SECOND count; resetsAt is exposed in milliseconds.
  const resetsAt = typeof resetAt === 'number' && Number.isFinite(resetAt)
    ? resetAt * 1000
    : typeof resetAfterSeconds === 'number' && Number.isFinite(resetAfterSeconds)
      ? now() + resetAfterSeconds * 1000
      : undefined
  return {
    id: fallbackId,
    label: fallbackLabel,
    usedPercent: boundedUsed,
    remainingPercent: Number((100 - boundedUsed).toFixed(6)),
    ...(typeof windowSeconds === 'number' && Number.isFinite(windowSeconds) ? { windowSeconds } : {}),
    ...(resetsAt === undefined ? {} : { resetsAt }),
    ...(typeof resetAfterSeconds === 'number' && Number.isFinite(resetAfterSeconds) ? { resetAfterSeconds } : {}),
    exhausted: boundedUsed >= 100,
  }
}

/**
 * Normalize a raw wham/usage response into a stable snapshot.
 * @param {unknown} data
 * @param {() => number} [now]
 * @returns {import('./types.js').BalanceSnapshot}
 */
export function normalizeBalanceResponse(data, now = Date.now) {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    throw new BalanceSchemaError('malformed-response', 'Balance response is malformed')
  }
  const record = /** @type {Record<string, unknown>} */ (data)
  const planType = record.plan_type
  if (planType !== undefined && typeof planType !== 'string') {
    throw new BalanceSchemaError('malformed-plan-type', 'Balance plan_type is malformed')
  }
  const rateLimit = record.rate_limit
  if (rateLimit === null || typeof rateLimit !== 'object' || Array.isArray(rateLimit)) {
    throw new BalanceSchemaError('malformed-rate-limit', 'Balance rate_limit is malformed')
  }
  const windows = []
  if (rateLimit.primary_window !== undefined) {
    windows.push(normalizeWindow(rateLimit.primary_window, 'primary', 'Primary', now))
  }
  if (rateLimit.secondary_window !== undefined) {
    windows.push(normalizeWindow(rateLimit.secondary_window, 'secondary', 'Secondary', now))
  }
  const additionalRaw = record.additional_rate_limits
  if (additionalRaw !== undefined && additionalRaw !== null) {
    if (!Array.isArray(additionalRaw)) {
      throw new BalanceSchemaError('malformed-additional-limits', 'Balance additional_rate_limits is malformed')
    }
    additionalRaw.forEach((entry, index) => {
      windows.push(normalizeWindow(entry, `additional-${index}`, `Additional ${index + 1}`, now))
    })
  }
  if (windows.length === 0) {
    throw new BalanceSchemaError('no-windows', 'Balance response has no usage windows')
  }
  const allowed = rateLimit.allowed
  const limitReached = rateLimit.limit_reached
  return {
    status: 'ready',
    ...(planType === undefined ? {} : { plan: planType }),
    fetchedAt: now(),
    windows,
    additionalLimits: additionalRaw === undefined || !Array.isArray(additionalRaw)
      ? []
      : additionalRaw.map((entry, index) => {
          const normalized = normalizeWindow(entry, `additional-${index}`, `Additional ${index + 1}`, now)
          return { id: normalized.id, label: normalized.label, usedPercent: normalized.usedPercent, remainingPercent: normalized.remainingPercent, ...(normalized.resetsAt === undefined ? {} : { resetsAt: normalized.resetsAt }) }
        }),
    ...(typeof allowed === 'boolean' ? { allowed } : {}),
    ...(typeof limitReached === 'boolean' ? { limitReached } : {}),
  }
}
