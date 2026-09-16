import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyRuntime, connectionTrust, waitForService } from '../src/runtime.js'
import { PROVIDER_ID, ROUTE_PREFIX, SETTINGS_NAMESPACE } from '../src/constants.js'

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
    registerModelDiscovery(settingsNs, discover) {
      this.discovery = { settingsNs, discover }
      return () => { this.discovery = undefined }
    },
  }
  const effects = []
  /**
   * Minimal stand-in for `ctx.inject`: registers the callback for the caller to
   * run once the services exist, and owns whatever the callback registers
   * through `scope.effect`.
   */
  const injections = []
  const available = {
    get credentials() { return credentials },
    get webServer() { return services.webServer },
    get llm() { return llm },
  }
  const services = { webServer }
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    get(name) {
      if (name === 'credentials') return credentials
      if (name === 'webServer') return services.webServer
      if (name === 'llm') return llm
      return undefined
    },
    inject(deps, callback) {
      const record = { deps, disposers: [], disposed: false, run: null, dispose: null }
      record.run = () => {
        const scope = {}
        for (const dep of deps) scope[dep] = available[dep]
        scope.effect = (fn) => {
          record.disposers.push(fn())
          return () => {}
        }
        callback(scope)
      }
      record.dispose = async () => {
        record.disposed = true
        for (const dispose of record.disposers.splice(0).reverse()) dispose()
      }
      injections.push(record)
      return record
    },
    effect(fn, label) {
      const disposer = fn()
      effects.push({ label, disposer })
      return () => disposer()
    },
  }
  return { ctx, credentials, webServer, llm, routes, effects, injections, services }
}

test('applyRuntime registers provider, directory, and routes', async () => {
  const { ctx, llm, routes, effects } = fakeContext()
  // A throwaway home keeps the meter's ledger and settings out of the real one.
  const home = await mkdtemp(join(tmpdir(), 'runtime-home-'))
  const result = await applyRuntime(ctx, { state: 'active', oauth: { clientId: 'cid' } }, { home, sleep: async () => {} })
  assert.equal(result.ok, true)
  assert.equal(llm.adapters.providers[0], PROVIDER_ID)
  assert.equal(llm.directory[0].provider, PROVIDER_ID)
  assert.equal(llm.directory[0].settingsNs, SETTINGS_NAMESPACE)
  const paths = routes.map((entry) => entry.path)
  assert.ok(paths.includes(`${ROUTE_PREFIX}/meter/usage`), 'the meter exposes its view model')
  assert.ok(paths.includes(`${ROUTE_PREFIX}/meter/settings`), 'the meter settings are editable')
  assert.equal(paths.length, new Set(paths).size, 'no route is registered twice')
  assert.equal(effects.length, 1)
  // Disposer should tear down registrations, and finish the ledger flush before
  // it resolves: polling for "some file appeared" would accept the temp file a
  // rename has not landed on yet.
  await effects[0].disposer()
  assert.equal(llm.adapters, undefined)
  assert.equal(llm.directory, undefined)
  assert.equal(routes.length, 0)
  const meterDir = join(home, 'storages', 'openai-subscription-meter')
  const residue = await readdir(meterDir).catch(() => [])
  assert.deepEqual(residue, ['usage.json'], 'the meter writes only inside the injected home')
})

test('applyRuntime registers the model discovery under the plugin namespace', async () => {
  const { ctx, llm, effects } = fakeContext()
  const home = await mkdtemp(join(tmpdir(), 'runtime-home-'))
  await applyRuntime(ctx, { state: 'active', oauth: { clientId: 'cid' } }, { home, sleep: async () => {} })
  assert.equal(llm.discovery.settingsNs, SETTINGS_NAMESPACE)
  // The catalog needs an authenticated read. A caller that is not signed in
  // must get that reason rather than an empty list it would read as "no models".
  await assert.rejects(llm.discovery.discover({ provider: PROVIDER_ID }), (error) => error.code === 'not-signed-in')
  await effects[0].disposer()
  assert.equal(llm.discovery, undefined, 'the discovery registration is released with the plugin')
})

test('applyRuntime arms an injection for a web server that is not there yet', async () => {
  const { ctx, webServer, routes, injections, services } = fakeContext()
  const home = await mkdtemp(join(tmpdir(), 'runtime-home-'))
  // No web server at activation: the runtime must not stall on the optional
  // service, and must not give up on mounting the routes either.
  const originalGet = ctx.get
  ctx.get = (name) => (name === 'webServer' ? undefined : originalGet(name))
  const result = await applyRuntime(ctx, { state: 'active', oauth: { clientId: 'cid' } }, { home, sleep: async () => { throw new Error('the optional web server must not be awaited') } })
  assert.equal(result.ok, true, 'an absent optional service never blocks activation')
  assert.equal(routes.length, 0)
  assert.equal(injections.length, 1)
  assert.deepEqual(injections[0].deps, ['webServer'])

  // The web server arrives: the injected callback mounts the routes onto it.
  services.webServer = webServer
  injections[0].run()
  assert.ok(routes.length > 0, 'routes mount once a web server exists')

  // ...and go away with it.
  await injections[0].dispose()
  assert.equal(routes.length, 0, 'the routes belong to the injected web server lifetime')
})

test('a web server that is already present mounts synchronously', async () => {
  const { ctx, routes, injections } = fakeContext()
  const home = await mkdtemp(join(tmpdir(), 'runtime-home-'))
  const result = await applyRuntime(ctx, { state: 'active', oauth: { clientId: 'cid' } }, { home, sleep: async () => {} })
  assert.equal(result.ok, true)
  assert.ok(routes.length > 0, 'the common path does not wait for an injection')
  assert.equal(injections.length, 0, 'no injection is armed when the server is already here')
})

test('applyRuntime stays disabled on provider conflict', async () => {
  const { ctx, llm } = fakeContext()
  llm.listProviders = () => [{ id: PROVIDER_ID, name: 'Other' }]
  const result = await applyRuntime(ctx, { state: 'active', oauth: { clientId: 'cid' } }, { home: await mkdtemp(join(tmpdir(), 'runtime-home-')) })
  assert.equal(result.ok, false)
  assert.equal(result.reason.includes('conflict'), true)
})

test('connectionTrust delegates to the deployment fence when one is mounted', () => {
  const decisions = []
  const ctx = {
    get(name) {
      if (name !== 'connection') return undefined
      return {
        requestRejection(request) {
          decisions.push(request.headers.host)
          return request.headers.host === 'ok.example' ? undefined : request.headers.host === 'auth.example' ? 401 : 403
        },
      }
    },
  }
  const trust = connectionTrust(ctx)
  assert.equal(typeof trust, 'function')
  assert.equal(trust({ headers: { host: 'ok.example' } }), undefined)
  assert.equal(trust({ headers: { host: 'auth.example' } }), 401)
  assert.equal(trust({ headers: { host: 'evil.example' } }), 403)
  assert.deepEqual(decisions, ['ok.example', 'auth.example', 'evil.example'], 'the fence decides, not the local comparison')
})

test('connectionTrust is absent without the service and refuses when the fence throws', () => {
  assert.equal(connectionTrust({ get: () => undefined }), undefined)
  assert.equal(connectionTrust({}), undefined)
  assert.equal(connectionTrust({ get() { throw new Error('no registry') } }), undefined)
  const broken = connectionTrust({ get: () => ({ requestRejection() { throw new Error('boom') } }) })
  assert.equal(broken({ headers: {} }), 403, 'a fence that cannot answer must not open the route')
})

test('a registration that fails part-way is rolled back before the error escapes', async () => {
  const { ctx, llm, webServer, routes, effects } = fakeContext()
  // The directory entry is refused after the adapter already registered, which
  // is exactly the ordering that used to strand an adapter with no owner.
  llm.registerConfigurableProviders = () => { throw new Error('configurable provider "openai-subscription" is already declared') }
  const home = await mkdtemp(join(tmpdir(), 'runtime-home-'))

  await assert.rejects(
    applyRuntime(ctx, { state: 'active', oauth: { clientId: 'cid' } }, { home, sleep: async () => {} }),
    /already declared/,
  )
  assert.equal(llm.adapters, undefined, 'the half-registered adapter must be released')
  assert.equal(routes.length, 0, 'no route may outlive a failed activation')
  // The effect body threw, so no disposer was ever returned to the fiber; the
  // failed activation itself must still have released what it owns.
  const meterDir = join(home, 'storages', 'openai-subscription-meter')
  await new Promise((resolve) => { setTimeout(resolve, 50) })
  const residue = await readdir(meterDir).catch(() => [])
  assert.deepEqual(residue, ['usage.json'], 'the ledger is flushed rather than left open')
  assert.equal(effects.length, 0, 'a failed setup never publishes a disposer')
})

test('a context without the effect API closes the meter it already opened', async () => {
  const { ctx } = fakeContext()
  delete ctx.effect
  const home = await mkdtemp(join(tmpdir(), 'runtime-home-'))
  const result = await applyRuntime(ctx, { state: 'active', oauth: { clientId: 'cid' } }, { home, sleep: async () => {} })
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'no-effect-api')
  // The meter was constructed before the effect API was found missing, and no
  // disposer will ever be returned for it: an open ledger here would only be
  // released by a process restart.
  const meterDir = join(home, 'storages', 'openai-subscription-meter')
  let residue = []
  for (let attempt = 0; attempt < 60 && residue.length === 0; attempt += 1) {
    residue = await readdir(meterDir).catch(() => [])
    if (residue.length === 0) await new Promise((resolve) => { setTimeout(resolve, 100) })
  }
  assert.deepEqual(residue, ['usage.json'], 'the ledger must have been flushed and closed')
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
  const result = await waitForService(ctx, 'credentials', { timeoutMs: 100, tickMs: 25, now: () => clock, sleep })
  assert.equal(result, undefined)
  assert.equal(sleeps, 4, 'four 25ms ticks exhaust the 100ms budget')
  assert.equal(clock, 100)
})
