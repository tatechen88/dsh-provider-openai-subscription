import test from 'node:test'
import assert from 'node:assert/strict'
import { BalanceService } from '../src/balance/service.js'

const now = () => 1000

function readySnapshot() {
  return { status: 'ready', windows: [{ id: 'primary', label: 'Primary', usedPercent: 10, remainingPercent: 90, exhausted: false }], additionalLimits: [], fetchedAt: now() }
}

test('BalanceService caches within TTL', async () => {
  let calls = 0
  const service = new BalanceService({ fetch: async () => { calls += 1; return readySnapshot() }, ttlMs: 1000, now })
  await service.get()
  await service.get()
  assert.equal(calls, 1)
})

test('BalanceService force refresh calls fetch', async () => {
  let calls = 0
  const service = new BalanceService({ fetch: async () => { calls += 1; return readySnapshot() }, ttlMs: 1000, now })
  await service.get(true)
  await service.get(true)
  assert.equal(calls, 2)
})

test('BalanceService single-flights concurrent refresh', async () => {
  let calls = 0
  const service = new BalanceService({
    fetch: async () => {
      calls += 1
      await new Promise((resolve) => setTimeout(resolve, 10))
      return readySnapshot()
    },
    ttlMs: 1000,
    now,
  })
  const [a, b] = await Promise.all([service.get(true), service.get(true)])
  assert.equal(calls, 1)
  assert.equal(a.status, 'ready')
  assert.equal(b.status, 'ready')
})

test('BalanceService returns stale when cache exists and fetch fails', async () => {
  const service = new BalanceService({
    fetch: async () => readySnapshot(),
    ttlMs: 0,
    now,
  })
  await service.get()
  service.cachedAt = 0
  service.fetch = async () => { const error = new Error('up'); error.code = 'upstream-error'; throw error }
  const snapshot = await service.get()
  assert.equal(snapshot.status, 'stale')
  assert.equal(snapshot.errorCode, 'upstream-error')
})

test('BalanceService returns error snapshot when no cache and fetch fails', async () => {
  const service = new BalanceService({
    fetch: async () => { const error = new Error('bad'); error.code = 'unauthorized'; throw error },
    ttlMs: 1000,
    now,
  })
  const snapshot = await service.get()
  assert.equal(snapshot.status, 'error')
  assert.equal(snapshot.errorCode, 'unauthorized')
})

test('BalanceService startPolling returns a disposer', async () => {
  let calls = 0
  const service = new BalanceService({ fetch: async () => { calls += 1; return readySnapshot() }, ttlMs: 1000, now })
  const stop = service.startPolling(20)
  await new Promise((resolve) => setTimeout(resolve, 45))
  stop()
  const afterStop = calls
  await new Promise((resolve) => setTimeout(resolve, 45))
  assert.equal(calls, afterStop)
})

test('BalanceService clear removes cache', async () => {
  let calls = 0
  const service = new BalanceService({ fetch: async () => { calls += 1; return readySnapshot() }, ttlMs: 100000, now })
  await service.get()
  service.clear()
  await service.get()
  assert.equal(calls, 2)
})
