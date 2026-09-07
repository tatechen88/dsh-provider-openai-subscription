import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeBalanceResponse, BalanceSchemaError } from '../src/balance/normalizer.js'

const raw = {
  plan_type: 'pro',
  rate_limit: {
    allowed: true,
    limit_reached: false,
    primary_window: { used_percent: 12, limit_window_seconds: 3600, reset_after_seconds: 1800, reset_at: 1786000000 },
    secondary_window: { used_percent: 88, limit_window_seconds: 604800, reset_after_seconds: 86400 },
  },
  additional_rate_limits: [{ used_percent: 100 }],
}

test('normalizeBalanceResponse produces stable snapshot', () => {
  const snapshot = normalizeBalanceResponse(raw, () => 1000)
  assert.equal(snapshot.status, 'ready')
  assert.equal(snapshot.plan, 'pro')
  assert.equal(snapshot.windows.length, 3)
  assert.equal(snapshot.windows[0].usedPercent, 12)
  assert.equal(snapshot.windows[0].remainingPercent, 88)
  assert.equal(snapshot.windows[0].resetsAt, 1786000000000, 'epoch-second reset_at converts to milliseconds')
  assert.equal(snapshot.windows[1].exhausted, false)
  assert.equal(snapshot.windows[2].exhausted, true)
  assert.equal(snapshot.additionalLimits.length, 1)
  assert.equal(snapshot.allowed, true)
  assert.equal(snapshot.limitReached, false)
})

test('normalizeBalanceResponse bounds used percent to 0..100', () => {
  const snapshot = normalizeBalanceResponse({
    rate_limit: {
      primary_window: { used_percent: 120 },
    },
  })
  assert.equal(snapshot.windows[0].usedPercent, 100)
  assert.equal(snapshot.windows[0].remainingPercent, 0)
  const low = normalizeBalanceResponse({ rate_limit: { primary_window: { used_percent: -5 } } })
  assert.equal(low.windows[0].usedPercent, 0)
})

test('normalizeBalanceResponse derives resetsAt from reset_after_seconds when reset_at missing', () => {
  const snapshot = normalizeBalanceResponse({
    rate_limit: { primary_window: { used_percent: 0, reset_after_seconds: 60 } },
  }, () => 1000)
  assert.equal(snapshot.windows[0].resetsAt, 61000)
})

test('normalizeBalanceResponse accepts null additional_rate_limits', () => {
  const snapshot = normalizeBalanceResponse({
    plan_type: 'plus',
    rate_limit: {
      allowed: true,
      limit_reached: false,
      primary_window: { used_percent: 0 },
      secondary_window: { used_percent: 3 },
    },
    additional_rate_limits: null,
  }, () => 1000)
  assert.equal(snapshot.status, 'ready')
  assert.equal(snapshot.windows.length, 2)
  assert.deepEqual(snapshot.additionalLimits, [])
})

test('normalizeBalanceResponse rejects malformed payloads', () => {
  assert.throws(() => normalizeBalanceResponse(null), BalanceSchemaError)
  assert.throws(() => normalizeBalanceResponse({}), BalanceSchemaError)
  assert.throws(() => normalizeBalanceResponse({ rate_limit: {} }), (error) => error.code === 'no-windows')
  assert.throws(() => normalizeBalanceResponse({ rate_limit: { primary_window: {} } }), (error) => error.code === 'malformed-used-percent')
  assert.throws(() => normalizeBalanceResponse({ rate_limit: { primary_window: { used_percent: 1 } }, additional_rate_limits: 'nope' }), (error) => error.code === 'malformed-additional-limits')
})
