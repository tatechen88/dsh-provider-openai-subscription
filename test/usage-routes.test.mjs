/**
 * Which routes the meter covers, from both ends.
 *
 * The vendor registry names the routes this plugin can read an account for, but
 * DSH is what knows which providers exist: a vendor another plugin registers has
 * to be counted from its first call, without a release here and without a copy of
 * the list compiled into the browser. These tests pin the discovery, its expiry,
 * its off switch, and the view the page reads its own list from.
 *
 * @module dsh-provider-openai-subscription/test/usage-routes
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createMeterRoutes, PROVIDER_LIST_TTL_MS } from '../src/runtime.js'
import { UsageLedger } from '../src/usage/ledger.js'
import { UsageMeterService } from '../src/usage/service.js'
import { METERED_PROVIDERS } from '../src/usage/vendors.js'

const REGISTRY = [...METERED_PROVIDERS]

test('the registry routes are metered whether or not DSH can be asked', () => {
  const routes = createMeterRoutes({}, { now: () => 0 })
  for (const id of REGISTRY) assert.equal(routes.covers(id), true, `${id} is a registry route`)
  assert.deepEqual(routes.known(), REGISTRY, 'and the view list starts as the registry')

  const nameless = createMeterRoutes({}, { now: () => 0 })
  assert.equal(nameless.covers(undefined), false, 'a route with no name is never metered')
  assert.equal(nameless.covers(''), false)
  assert.equal(nameless.covers(42), false)
})

test('a provider another plugin registered is metered from its first call', () => {
  let asked = 0
  const ctx = {
    llm: {
      listProviders: () => {
        asked += 1
        return [{ id: 'acme-llm' }, { id: 'deepseek-official' }, { id: '' }, null]
      },
    },
  }
  const routes = createMeterRoutes(ctx, { now: () => 0 })
  assert.equal(routes.covers('acme-llm'), true, 'a discovered provider is metered')
  assert.deepEqual(
    routes.known(),
    [...REGISTRY, 'acme-llm'],
    'the view lists it after the registry, without duplicates or blank ids',
  )
  assert.equal(asked, 1, 'the provider list is asked once and remembered')
})

test('the discovered list expires, so a provider registered later is still found', () => {
  let now = 0
  let listed = [{ id: 'acme-llm' }]
  const ctx = { llm: { listProviders: () => listed } }
  const routes = createMeterRoutes(ctx, { now: () => now })

  assert.equal(routes.covers('acme-llm'), true)
  assert.equal(routes.covers('beta-llm'), false, 'a provider that has not registered yet is passed through')

  listed = [{ id: 'acme-llm' }, { id: 'beta-llm' }]
  now = PROVIDER_LIST_TTL_MS
  assert.equal(routes.covers('beta-llm'), true, 'the cached list expires instead of freezing the process')
})

test('the auto switch restores the fixed registry, and a broken catalogue is not fatal', () => {
  const ctx = { llm: { listProviders: () => [{ id: 'acme-llm' }] } }
  const fixed = createMeterRoutes(ctx, { auto: false, now: () => 0 })
  assert.equal(fixed.covers('acme-llm'), false, 'with auto off only the registry is metered')
  assert.equal(fixed.covers('deepseek-official'), true)
  assert.deepEqual(fixed.known(), REGISTRY)

  const broken = createMeterRoutes({
    get llm() { throw new Error('this context has no llm service') },
  }, { now: () => 0 })
  assert.equal(broken.covers('deepseek-official'), true, 'the registry routes survive a context without llm')
  assert.deepEqual(broken.known(), REGISTRY)
})

test('the view reports the routes the host meters, and never an empty list', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'usage-routes-'))
  const ledger = new UsageLedger({ path: join(dir, 'usage.json'), debounceMs: 60_000, now: () => 1 })
  await ledger.open()
  try {
    const listed = new UsageMeterService({ ledger, now: () => 1, listRoutes: () => [...REGISTRY, 'acme-llm'] })
    assert.deepEqual(listed.view().metered, { auto: true, providers: [...REGISTRY, 'acme-llm'] })

    const silent = new UsageMeterService({ ledger, now: () => 1, listRoutes: () => [] })
    assert.deepEqual(silent.view().metered.providers, REGISTRY, 'an empty answer keeps the registry routes')

    const broken = new UsageMeterService({
      ledger,
      now: () => 1,
      listRoutes: () => { throw new Error('this context has no llm service') },
    })
    assert.deepEqual(broken.view().metered.providers, REGISTRY)

    const fixed = new UsageMeterService({ ledger, now: () => 1, config: { autoProviders: false } })
    assert.equal(fixed.view().metered.auto, false, 'the switch is reported, so the page can explain a missing route')
    assert.deepEqual(fixed.view().metered.providers, REGISTRY)
  } finally {
    await ledger.close()
    await rm(dir, { recursive: true, force: true })
  }
})
