/**
 * Meter HTTP route contracts.
 *
 * @module dsh-provider-openai-subscription/test/web-routes-meter
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { mountRoutes } from '../src/web/routes.js'
import { ROUTE_PREFIX } from '../src/constants.js'

/** Minimal ServerResponse stand-in. */
function fakeResponse() {
  const state = { status: 0, body: '', headers: {} }
  return {
    state,
    writeHead(status, headers = {}) {
      state.status = status
      state.headers = headers
    },
    end(text = '') {
      state.body = text
    },
  }
}

/** Minimal IncomingMessage stand-in. */
function fakeRequest({ method = 'GET', url = '/', origin = 'http://localhost:1234', host = 'localhost:1234', body } = {}) {
  const headers = { host, origin }
  if (body === undefined) {
    return { method, url, headers, [Symbol.asyncIterator]() { return [][Symbol.iterator]() } }
  }
  const stream = Readable.from([Buffer.from(body)])
  stream.method = method
  stream.url = url
  stream.headers = headers
  return stream
}

/** A web server that records registrations. */
function fakeWebServer() {
  const routes = []
  return {
    routes,
    register(route) {
      routes.push(route)
      return () => {
        const index = routes.indexOf(route)
        if (index >= 0) routes.splice(index, 1)
      }
    },
  }
}

/** Route-under-test harness: one meter stub, one settings stub. */
function harness() {
  const calls = { refresh: 0, zhipuRefresh: 0, patches: [], views: [] }
  const service = {
    view: (options = {}) => {
      calls.views.push(options)
      return {
        generatedAt: 1,
        sessionId: options.sessionId,
        deepseek: { status: 'ok' },
        zhipu: { status: 'ok', packages: [] },
        usage: { session: {}, today: {}, month: {} },
      }
    },
    refreshDeepSeekBalance: async () => {
      calls.refresh += 1
      return { status: 'ok' }
    },
    refreshZhipuAccount: async () => {
      calls.zhipuRefresh += 1
      return { status: 'ok' }
    },
    updateConfig: (config) => { calls.config = config },
  }
  const settings = {
    revision: 3,
    resolved: () => ({ accountKind: 'enterprise' }),
    editable: () => ({ accountKind: 'enterprise' }),
    update: async (patch, expectedRevision) => {
      calls.patches.push({ patch, expectedRevision })
      if (expectedRevision !== 3) {
        const error = new Error('meter settings moved')
        error.code = 'settings-conflict'
        error.actualRevision = 7
        throw error
      }
      const config = { accountKind: patch.accountKind ?? 'enterprise' }
      return { revision: 4, config, raw: config }
    },
  }
  const web = fakeWebServer()
  const deps = {
    repository: { status: async () => ({ configured: false }) },
    attempts: { get: () => undefined },
    balance: { get: async () => ({ status: 'ready' }), clear: () => {} },
    clientId: 'cid',
    exchange: async () => ({ access: 'a', expires: 1 }),
    meter: { service, settings, openaiQuota: async () => ({ status: 'ready', windows: [] }) },
  }
  const dispose = mountRoutes({ webServer: web }, deps)
  return { web, calls, dispose }
}

/** Find one registered route by suffix. */
function routeOf(web, path) {
  return web.routes.find((route) => route.path === `${ROUTE_PREFIX}${path}`)
}

test('meter usage route returns the view model with the current subscription quota', async () => {
  const { web, dispose } = harness()
  const response = fakeResponse()
  await routeOf(web, '/meter/usage').handler(fakeRequest({ url: '/?sessionId=s1' }), response)
  const payload = JSON.parse(response.state.body)
  assert.equal(response.state.status, 200)
  assert.equal(payload.ok, true)
  assert.equal(payload.data.sessionId, 's1')
  assert.deepEqual(payload.data.openaiQuota, { status: 'ready', windows: [] })
  dispose()
})

test('meter settings live on one path and dispatch by method', async () => {
  const { web, calls, dispose } = harness()
  const route = routeOf(web, '/meter/settings')
  assert.notEqual(route, undefined, 'the settings path is registered once')
  assert.equal(web.routes.filter((entry) => entry.path === route.path).length, 1)

  const read = fakeResponse()
  await route.handler(fakeRequest(), read)
  assert.equal(JSON.parse(read.state.body).data.revision, 3)

  const write = fakeResponse()
  await route.handler(
    fakeRequest({ method: 'PATCH', body: JSON.stringify({ patch: { accountKind: 'enterprise' }, expectedRevision: 3 }) }),
    write,
  )
  assert.equal(write.state.status, 200)
  assert.equal(calls.patches.length, 1)
  assert.equal(calls.config.accountKind, 'enterprise', 'the running meter picks the new configuration up')

  const deleteMethod = fakeResponse()
  await route.handler(fakeRequest({ method: 'DELETE' }), deleteMethod)
  assert.equal(deleteMethod.state.status, 405)
  assert.equal(deleteMethod.state.headers.allow, 'GET, PATCH')
  dispose()
})

test('a stale settings revision is reported as a conflict, not applied', async () => {
  const { web, calls, dispose } = harness()
  const response = fakeResponse()
  await routeOf(web, '/meter/settings').handler(
    fakeRequest({ method: 'PATCH', body: JSON.stringify({ patch: { hideCost: true }, expectedRevision: 1 }) }),
    response,
  )
  assert.equal(response.state.status, 409)
  const failure = JSON.parse(response.state.body)
  assert.equal(failure.ok, false)
  assert.equal(failure.actualRevision, 7, 'the caller learns the revision it has to retry with')
  assert.equal(calls.config, undefined, 'nothing is applied on a conflict')
  dispose()
})

test('a settings write without a revision is refused instead of overwriting', async () => {
  const { web, calls, dispose } = harness()
  const response = fakeResponse()
  await routeOf(web, '/meter/settings').handler(
    fakeRequest({ method: 'PATCH', body: JSON.stringify({ patch: { hideCost: true } }) }),
    response,
  )
  assert.equal(response.state.status, 400)
  assert.match(JSON.parse(response.state.body).error, /expectedRevision/)
  assert.equal(calls.patches.length, 0, 'the store is never asked to overwrite blindly')
  dispose()
})

test('the usage route hands the vendor hint through, and the Zhipu route reads its account', async () => {
  const { web, calls, dispose } = harness()

  const usage = fakeResponse()
  await routeOf(web, '/meter/usage').handler(fakeRequest({ url: '/?sessionId=s1&provider=zai-coding-cn' }), usage)
  assert.equal(usage.state.status, 200)
  assert.deepEqual(
    calls.views.at(-1),
    { sessionId: 's1', provider: 'zai-coding-cn' },
    'the route tells the service which vendor this read is about',
  )
  assert.deepEqual(JSON.parse(usage.state.body).data.zhipu, { status: 'ok', packages: [] })

  const refresh = fakeResponse()
  await routeOf(web, '/meter/zhipu/refresh').handler(fakeRequest({ method: 'POST' }), refresh)
  assert.equal(refresh.state.status, 200)
  assert.equal(calls.zhipuRefresh, 1)
  dispose()
})

test('the refresh route forces one DeepSeek reading and returns the balance slice', async () => {
  const { web, calls, dispose } = harness()
  const response = fakeResponse()
  await routeOf(web, '/meter/deepseek/refresh').handler(fakeRequest({ method: 'POST' }), response)
  const payload = JSON.parse(response.state.body)
  assert.equal(payload.data.status, 'ok')
  assert.equal(calls.refresh, 1)
  dispose()
})

test('a foreign origin cannot read or change meter state', async () => {
  const { web, dispose } = harness()
  const response = fakeResponse()
  await routeOf(web, '/meter/usage').handler(fakeRequest({ origin: 'http://evil.example' }), response)
  assert.equal(response.state.status, 403)
  dispose()
})

test('a meter without a service reports itself unavailable instead of failing the request', async () => {
  const web = fakeWebServer()
  const settings = { revision: 0, resolved: () => ({ accountKind: 'unknown' }), editable: () => ({ accountKind: 'unknown' }), update: async () => ({ revision: 1, config: {}, raw: {} }) }
  const dispose = mountRoutes({ webServer: web }, {
    repository: { status: async () => ({ configured: false }) },
    attempts: { get: () => undefined },
    balance: { get: async () => ({ status: 'ready' }), clear: () => {} },
    clientId: 'cid',
    exchange: async () => ({ access: 'a', expires: 1 }),
    // Exactly what createMeter returns when its ledger cannot be opened.
    meter: { service: undefined, settings, openaiQuota: async () => ({ status: 'ready', windows: [] }) },
  })

  const usage = fakeResponse()
  await routeOf(web, '/meter/usage').handler(fakeRequest(), usage)
  assert.equal(usage.state.status, 200)
  const payload = JSON.parse(usage.state.body).data
  assert.equal(payload.status, 'unavailable')
  assert.deepEqual(payload.openaiQuota, { status: 'ready', windows: [] }, 'the subscription quota does not depend on the ledger')

  const refresh = fakeResponse()
  await routeOf(web, '/meter/deepseek/refresh').handler(fakeRequest({ method: 'POST' }), refresh)
  assert.equal(refresh.state.status, 200)
  assert.equal(JSON.parse(refresh.state.body).ok, false)

  // Settings still persist even with no running service to reconfigure.
  const patch = fakeResponse()
  await routeOf(web, '/meter/settings').handler(
    fakeRequest({ method: 'PATCH', body: JSON.stringify({ patch: { hideCost: true }, expectedRevision: 0 }) }),
    patch,
  )
  assert.equal(patch.state.status, 200)
  dispose()
})
