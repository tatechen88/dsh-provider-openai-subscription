import test from 'node:test'
import assert from 'node:assert/strict'
import { applyRuntime } from '../src/runtime.js'
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
