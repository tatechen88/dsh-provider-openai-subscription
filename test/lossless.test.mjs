import test from 'node:test'
import assert from 'node:assert/strict'

import { lossless } from '../src/lossless.js'

/**
 * A tool result is materialized as lossless JSON, and the harness refuses the
 * whole call when it is not. `usage_meter_report` learned this the hard way: a
 * projection that copies fields out of a view passes their `undefined` through,
 * and the call fails with "value is not lossless JSON" instead of reporting the
 * numbers it had.
 */

/** The check the harness applies, in miniature. */
function isLossless(value) {
  if (value === undefined) return false
  if (typeof value === 'number') return Number.isFinite(value)
  if (typeof value === 'function' || typeof value === 'symbol' || typeof value === 'bigint') return false
  if (Array.isArray(value)) return value.every(isLossless)
  if (value !== null && typeof value === 'object') return Object.values(value).every(isLossless)
  return true
}

test('an absent field is dropped rather than passed through', () => {
  const fixed = lossless({ calls: 3, band: undefined, nested: { a: 1, b: undefined } })
  assert.deepEqual(fixed, { calls: 3, nested: { a: 1 } })
  assert.equal(isLossless(fixed), true)
})

test('numbers that cannot be represented become null, not zero', () => {
  const fixed = lossless({ ratio: Number.NaN, infinite: Number.POSITIVE_INFINITY, ok: 0.5 })
  assert.deepEqual(fixed, { ratio: null, infinite: null, ok: 0.5 })
})

test('arrays keep their shape and lose only what cannot be carried', () => {
  const fixed = lossless([1, undefined, { a: undefined, b: 2 }, Number.NaN])
  assert.deepEqual(fixed, [1, null, { b: 2 }, null])
})

test('an already-lossless payload survives untouched', () => {
  const payload = { calls: 2, usage: { inputTokens: 10 }, models: [{ id: 'x', calls: 2 }], amountCurrency: 'CNY' }
  assert.deepEqual(lossless(payload), payload)
})

test('the meter report survives the boundary even when the view is thin', async () => {
  // The shape the tool builds: fields taken straight off a view, several of
  // which a deployment may simply not have.
  const { toolOptions } = await import('../src/tools.js')
  const view = { generatedAt: 1, usage: { today: { calls: 0 } } }
  const options = toolOptions({
    operations: {
      status: async () => ({}),
      login: async () => ({}),
      logout: async () => ({}),
      quota: async () => ({}),
      usage: async () => ({
        status: 'ok',
        generatedAt: view.generatedAt,
        account: undefined,
        display: undefined,
        privacy: undefined,
        usage: view.usage,
        estimated: true,
        basis: 'request-start-assumption',
        unpricedModels: undefined,
        band: undefined,
        balance: undefined,
      }),
    },
  })
  const report = options.find((entry) => entry.name === 'usage_meter_report')
  const value = await report.execute({}, {})
  assert.equal(isLossless(value), true)
  assert.deepEqual(value, {
    status: 'ok',
    generatedAt: 1,
    usage: { today: { calls: 0 } },
    estimated: true,
    basis: 'request-start-assumption',
  })
})

test('every tool result crosses the same boundary', async () => {
  const { toolOptions } = await import('../src/tools.js')
  const operations = {
    status: async () => ({ configured: true, legacy: undefined }),
    login: async () => ({ status: 'pending' }),
    logout: async () => ({ status: 'signed-out' }),
    quota: async () => ({ status: 'ready', windows: [{ id: 'primary', resetsAt: undefined }] }),
    usage: async () => ({ status: 'ok' }),
  }
  for (const entry of toolOptions({ operations })) {
    const value = await entry.execute({}, {})
    assert.equal(isLossless(value), true, `${entry.name} must return lossless JSON`)
  }
})
