import test from 'node:test'
import assert from 'node:assert/strict'
import { applyRuntime, waitForService } from '../src/runtime.js'
import { PROVIDER_ID, SETTINGS_NAMESPACE } from '../src/constants.js'

function fakeContext() {
  const records = new Map()
  const credentials = {
    async readRecord(key) { return records.get(key) },
    async modifyRecord(key, mutate) {
      const current = records.get(key)
      const next = await mutate(current)
      if (next === undefined) records.delete(key)
      else records.set(key, next)
      return records.get(key)
    },
    async deleteRecord(key) { records.delete(key) },
    async describeRecord(key) {
      const record = records.get(key)
      return { configured: record !== undefined, kind: record?.kind, writable: true }
    },
  }
  const routes = []
  const webServer = {
    register(route) {
      routes.push(route)
      return () => {
        const index = routes.indexOf(route)
        if (index >= 0) routes.splice(index, 1)
      }
    },
  }
  const llm = {
    listProviders() { return [] },
    listConfigurableProviders() { return [] },
    registerAdapter(providers, adapter) {
      this.adapters = { providers, adapter }
      return () => { this.adapters = undefined }
    },
    registerConfigurableProviders(entries) {
      this.directory = entries
      return () => { this.directory = undefined }
    },
  }
  const effects = []
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    get(name) {
      if (name === 'credentials') return credentials
      if (name === 'webServer') return webServer
      if (name === 'llm') return llm
      return undefined
    },
    effect(fn, label) {
      const disposer = fn()
      effects.push({ label, disposer })
      return () => disposer()
    },
  }
  return { ctx, credentials, webServer, llm, routes, effects }
}

test('applyRuntime registers provider, directory, and routes', async () => {
  const { ctx, llm, routes, effects } = fakeContext()
  const result = await applyRuntime(ctx, { state: 'active', oauth: { clientId: 'cid' } })
  assert.equal(result.ok, true)
  assert.equal(llm.adapters.providers[0], PROVIDER_ID)
  assert.equal(llm.directory[0].provider, PROVIDER_ID)
  assert.equal(llm.directory[0].settingsNs, SETTINGS_NAMESPACE)
  assert.equal(routes.length, 14)
  assert.equal(effects.length, 1)
  // Disposer should tear down registrations.
  effects[0].disposer()
  assert.equal(llm.adapters, undefined)
  assert.equal(llm.directory, undefined)
  assert.equal(routes.length, 0)
})

test('applyRuntime stays disabled on provider conflict', async () => {
  const { ctx, llm } = fakeContext()
  llm.listProviders = () => [{ id: PROVIDER_ID, name: 'Other' }]
  const result = await applyRuntime(ctx, { state: 'active', oauth: { clientId: 'cid' } })
  assert.equal(result.ok, false)
  assert.equal(result.reason.includes('conflict'), true)
})

test('waitForService returns an already-available service without sleeping', async () => {
  const service = { marker: true }
  let polls = 0
  const ctx = { get() { polls += 1; return service } }
  const result = await waitForService(ctx, 'credentials', {
    timeoutMs: 100,
    sleep: async () => { throw new Error('waitForService must not sleep when the service is present') },
  })
  assert.equal(result, service)
  assert.equal(polls, 1)
})

test('waitForService polls until a late service appears', async () => {
  let service
  let clock = 0
  const ctx = { get() { return service } }
  let sleeps = 0
  const sleep = async () => {
    sleeps += 1
    clock += 25
    service = { marker: true } // the provider registers after the first tick
  }
  const result = await waitForService(ctx, 'credentials', { timeoutMs: 100, tickMs: 25, now: () => clock, sleep })
  assert.equal(result.marker, true)
  assert.equal(sleeps, 1)
  assert.equal(clock, 25)
})

test('waitForService gives up after the timeout', async () => {
  const ctx = { get() { return undefined } }
  let clock = 0
  let sleeps = 0
  const sleep = async () => {
    sleeps += 1
    clock += 25
  }
  const result = await waitForService(ctx, 'webServer', { timeoutMs: 100, tickMs: 25, now: () => clock, sleep })
  assert.equal(result, undefined)
  assert.equal(sleeps, 4, 'four 25ms ticks exhaust the 100ms budget')
  assert.equal(clock, 100)
})

test('applyRuntime waits for a late webServer before mounting routes', async () => {
  const { ctx, webServer, routes } = fakeContext()
  // Hide webServer behind the first poll so the wait path is exercised.
  const originalGet = ctx.get
  let visible = false
  ctx.get = (name) => {
    if (name === 'webServer') return visible ? webServer : undefined
    return originalGet(name)
  }
  const sleep = async () => { visible = true }
  const result = await applyRuntime(ctx, { state: 'active', oauth: { clientId: 'cid' } }, { sleep, timeoutMs: 100 })
  assert.equal(result.ok, true)
  assert.ok(routes.length > 0, 'routes must mount after webServer appears')
})
