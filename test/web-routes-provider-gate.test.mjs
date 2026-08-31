import test from 'node:test'
import assert from 'node:assert/strict'
import { mountRoutes } from '../src/web/routes.js'
import { ROUTE_PREFIX } from '../src/constants.js'

function response() { return { state: {}, writeHead(status) { this.state.status = status }, end(body) { this.state.body = body } } }
function request(method, url, body) {
  const headers = { host: 'localhost:1234', origin: 'http://localhost:1234' }
  if (body === undefined) return { method, url, headers, async *[Symbol.asyncIterator]() {} }
  return { method, url, headers, async *[Symbol.asyncIterator]() { yield Buffer.from(body) } }
}

test('balance returns inactive-provider without upstream fetch for legacy provider', async () => {
  const routes = []
  let fetches = 0
  const webServer = { register(route) { routes.push(route); return () => {} } }
  const balance = { async get() { fetches += 1; return { status: 'ready' } }, clear() {} }
  mountRoutes({ webServer }, {
    repository: { status: async () => ({ configured: false }), delete: async () => {} },
    attempts: { create: async () => ({}), get: () => undefined, dispose: async () => {} },
    balance,
    clientId: 'cid',
    exchange: async () => ({ access: 'a', expires: 1 }),
  })
  const route = routes.find(entry => entry.path === `${ROUTE_PREFIX}/balance`)
  const res = response()
  await route.handler(request('GET', '/plugins/openai-subscription/balance?provider=openai-codex'), res)
  assert.equal(res.state.status, 200)
  assert.deepEqual(JSON.parse(res.state.body).data, { available: false, reason: 'inactive-provider' })
  assert.equal(fetches, 0)
})
