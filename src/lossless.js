/**
 * The one place a tool result is made safe to hand to a model.
 *
 * The harness materializes a tool result as **lossless JSON**, and refuses the
 * whole call when the value is not: an `undefined` field, a function, or a
 * non-finite number fails the run with `value is not lossless JSON` — which is
 * exactly what `usage_meter_report` did the first time it ran against a real
 * ledger, because a projection that copies fields from a view passes their
 * `undefined` straight through.
 *
 * Dropping an absent field is the honest repair: the key is absent because the
 * deployment has nothing to say about it, and "absent" is what a reader already
 * handles. Numbers that cannot be represented become `null` rather than a
 * silent zero — the same rule the meter already applies to a cache-hit ratio it
 * cannot compute.
 *
 * @module dsh-provider-openai-subscription/lossless
 */

/**
 * Return the same value with everything lossless JSON cannot carry removed.
 *
 * @param {unknown} value - any tool result.
 * @returns {unknown} the same shape, minus `undefined`, functions and non-finite numbers.
 */
export function lossless(value) {
  // A hole cannot be dropped from an array without moving every later element,
  // so it becomes `null` — which is what JSON itself does with it.
  if (Array.isArray(value)) return value.map((child) => (child === undefined ? null : lossless(child)))
  if (value === null || typeof value !== 'object') {
    if (typeof value !== 'number') return value
    return Number.isFinite(value) ? value : null
  }
  const result = {}
  for (const [key, child] of Object.entries(value)) {
    if (child === undefined) continue
    result[key] = lossless(child)
  }
  return result
}
