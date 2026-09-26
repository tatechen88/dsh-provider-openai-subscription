import test from 'node:test'
import assert from 'node:assert/strict'

import { mountRoutes, sameOrigin, sendJson, safeError } from '../src/web/routes.js'
import { ROUTE_PREFIX } from '../src/constants.js'

/**
 * One route, one fence.
 *
 * The browser half's API is gone, so most of what this file used to cover went
 * with it. What remains is the part an operator depends on: the single status
 * endpoint is reachable, refuses a caller the deployment does not trust, and
 * leaves nothing behind when it cannot mount.
 */

/** A web-server stand-in that records what was registered. */
function fakeServer() {
  const routes = new Map()
  return {
    routes,
    register(route) {
      if (routes.has(route.path)) throw new Error(`duplicate route ${route.path}`)
      routes.set(route.path, route)
      return () => routes.delete(route.path)
    },
  }
}

/** A `node:http`-shaped response stand-in. */
function fakeResponse() {
  return {
    status: undefined,
    headers: undefined,
    body: '',
    writeHead(status, headers) {
      this.status = status
      this.headers = headers
    },
    end(body = '') {
      this.body = body
    },
  }
}

const statusOperations = {
  status: async () => ({ provider: 'openai-subscription', configured: true }),
}

test('sameOrigin accepts matching origins and rejects mismatches', () => {
  assert.equal(sameOrigin({ headers: {} }), true, 'a non-browser caller sends no Origin')
  assert.equal(sameOrigin({ headers: { origin: 'http://127.0.0.1:19387', host: '127.0.0.1:19387' } }), true)
  assert.equal(sameOrigin({ headers: { origin: 'https://evil.example', host: '127.0.0.1:19387' } }), false)
  assert.equal(sameOrigin({ headers: { origin: 'http://127.0.0.1:19387' } }), false, 'no Host to compare against')
})

test('mountRoutes registers exactly the status route', () => {
  const server = fakeServer()
  const dispose = mountRoutes({ webServer: server }, { operations: statusOperations })
  assert.deepEqual([...server.routes.keys()], [`${ROUTE_PREFIX}/status`])
  dispose()
  assert.equal(server.routes.size, 0, 'the disposer releases the route it registered')
})

test('the status route answers with the operations status', async () => {
  const server = fakeServer()
  mountRoutes({ webServer: server }, { operations: statusOperations })
  const route = server.routes.get(`${ROUTE_PREFIX}/status`)
  const response = fakeResponse()
  await route.handler({ method: 'GET', headers: {} }, response)
  assert.equal(response.status, 200)
  assert.deepEqual(JSON.parse(response.body), {
    ok: true,
    data: { provider: 'openai-subscription', configured: true },
  })
  assert.equal(response.headers['cache-control'], 'no-store')
})

test('a method the route does not serve is refused without running it', async () => {
  const server = fakeServer()
  let ran = 0
  mountRoutes({ webServer: server }, {
    operations: {
      status: async () => {
        ran += 1
        return {}
      },
    },
  })
  const route = server.routes.get(`${ROUTE_PREFIX}/status`)
  const response = fakeResponse()
  await route.handler({ method: 'POST', headers: {} }, response)
  assert.equal(response.status, 405)
  assert.equal(response.headers.allow, 'GET')
  assert.equal(ran, 0)
})

test('a supplied trust fence decides the request instead of sameOrigin', async () => {
  const server = fakeServer()
  mountRoutes({ webServer: server }, {
    operations: statusOperations,
    authorize: (request) => (request.headers['x-trusted'] === 'yes' ? undefined : 401),
  })
  const route = server.routes.get(`${ROUTE_PREFIX}/status`)

  const refused = fakeResponse()
  await route.handler({ method: 'GET', headers: {} }, refused)
  assert.equal(refused.status, 401)
  assert.equal(JSON.parse(refused.body).error, 'authentication required')

  const trusted = fakeResponse()
  await route.handler({ method: 'GET', headers: { 'x-trusted': 'yes' } }, trusted)
  assert.equal(trusted.status, 200)
})

test('a cross-origin caller is refused by the fallback fence', async () => {
  const server = fakeServer()
  mountRoutes({ webServer: server }, { operations: statusOperations })
  const route = server.routes.get(`${ROUTE_PREFIX}/status`)
  const response = fakeResponse()
  await route.handler({ method: 'GET', headers: { origin: 'https://evil.example', host: '127.0.0.1:19387' } }, response)
  assert.equal(response.status, 403)
  assert.equal(JSON.parse(response.body).error, 'untrusted origin')
})

test('a failing status read is reported without leaking internals', async () => {
  const server = fakeServer()
  mountRoutes({ webServer: server }, {
    operations: {
      status: async () => {
        throw new Error('credentials store is unreadable')
      },
    },
  })
  const route = server.routes.get(`${ROUTE_PREFIX}/status`)
  const response = fakeResponse()
  await route.handler({ method: 'GET', headers: {} }, response)
  assert.equal(response.status, 500)
  assert.equal(JSON.parse(response.body).error, 'credentials store is unreadable')
})

test('a route that cannot register leaves no route behind', () => {
  const server = {
    register() {
      throw new Error('duplicate route')
    },
  }
  assert.throws(() => mountRoutes({ webServer: server }, { operations: statusOperations }), /duplicate route/)
})

test('sendJson and safeError keep their contracts', () => {
  const response = fakeResponse()
  sendJson(response, 418, { ok: false })
  assert.equal(response.status, 418)
  assert.equal(response.headers['content-length'], Buffer.byteLength('{"ok":false}'))
  assert.equal(safeError(new Error('boom')), 'boom')
  assert.equal(safeError('a string'), 'request failed')
  assert.equal(safeError(new Error('')), 'request failed')
})
