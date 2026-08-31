import test from 'node:test'
import assert from 'node:assert/strict'
import { mountRoutes, sameOrigin, readJsonBody } from '../src/web/routes.js'
import { ROUTE_PREFIX } from '../src/constants.js'
import { CredentialRepository } from '../src/credentials/repository.js'
import { OAuthAttemptManager } from '../src/oauth/attempt-manager.js'
import { BalanceService } from '../src/balance/service.js'
import { Readable } from 'node:stream'

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

function fakeRequest({ method = 'GET', url = '/', origin, host = 'localhost:1234', body } = {}) {
  const headers = { host, ...(origin === undefined ? {} : { origin }) }
  if (body === undefined) {
    return { method, url, headers, [Symbol.asyncIterator]() { return [][Symbol.iterator]() } }
  }
  const stream = Readable.from([Buffer.from(body)])
  stream.method = method
  stream.url = url
  stream.headers = headers
  return stream
}

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

function deps() {
  const records = new Map()
  const provider = {
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
  const repository = new CredentialRepository(provider)
  const attempts = new OAuthAttemptManager({
    clientId: 'cid',
    repository,
    port: 0,
    exchange: async () => ({ access: 'at', refresh: 'rt', expires: Date.now() + 1000, idToken: 'x.y.z' }),
  })
  const balance = new BalanceService({ fetch: async () => ({ status: 'ready', windows: [], additionalLimits: [], fetchedAt: 1 }) })
  return { provider, repository, attempts, balance }
}

function findRoute(web, path) {
  return web.routes.find((route) => route.path === `${ROUTE_PREFIX}${path}`)
}

test('sameOrigin accepts matching origin and rejects mismatches', () => {
  assert.equal(sameOrigin({ headers: { origin: 'http://localhost:1234', host: 'localhost:1234' } }), true)
  assert.equal(sameOrigin({ headers: { origin: 'http://evil.example', host: 'localhost:1234' } }), false)
  assert.equal(sameOrigin({ headers: { host: 'localhost:1234' } }), false)
  assert.equal(sameOrigin({ headers: { host: 'localhost:1234', 'sec-fetch-site': 'same-origin' } }), true)
})

test('readJsonBody reads bounded JSON object', async () => {
  const req = fakeRequest({ method: 'POST', url: '/', origin: 'http://localhost:1234', body: '{"a":1}' })
  assert.deepEqual(await readJsonBody(req), { a: 1 })
})

test('readJsonBody rejects non-object JSON', async () => {
  const req = fakeRequest({ method: 'POST', url: '/', origin: 'http://localhost:1234', body: '[1]' })
  await assert.rejects(readJsonBody(req), /object/)
})

test('mountRoutes registers all expected paths', () => {
  const web = fakeWebServer()
  const { repository, attempts, balance } = deps()
  const dispose = mountRoutes({ webServer: web }, { repository, attempts, balance, clientId: 'cid', exchange: async () => ({ access: 'a', expires: 1 }) })
  assert.equal(web.routes.length, 8)
  dispose()
  assert.equal(web.routes.length, 0)
})

test('mountRoutes registers device routes when a device manager is provided', () => {
  const web = fakeWebServer()
  const { repository, attempts, balance } = deps()
  const devices = { create: async () => ({}), get: () => undefined, dispose: async () => {} }
  const dispose = mountRoutes({ webServer: web }, { repository, attempts, devices, balance, clientId: 'cid', exchange: async () => ({ access: 'a', expires: 1 }) })
  assert.equal(web.routes.length, 11)
  dispose()
  assert.equal(web.routes.length, 0)
})

test('mountRoutes registers model routes when listModels is provided', async () => {
  const web = fakeWebServer()
  const { repository, attempts, balance } = deps()
  const devices = { create: async () => ({}), get: () => undefined, dispose: async () => {} }
  const listModels = async () => [{ id: 'gpt-5', name: 'GPT-5' }]
  mountRoutes({ webServer: web }, { repository, attempts, devices, balance, listModels, clientId: 'cid', exchange: async () => ({ access: 'a', expires: 1 }) })
  const res = fakeResponse()
  const req = fakeRequest({ method: 'GET', url: '/plugins/openai-subscription/models', origin: 'http://localhost:1234' })
  await findRoute(web, '/models').handler(req, res)
  assert.equal(res.state.status, 200)
  const body = JSON.parse(res.state.body)
  assert.deepEqual(body.data, [{ id: 'gpt-5', name: 'GPT-5' }])
})

test('status route returns configured false when signed out', async () => {
  const web = fakeWebServer()
  const { repository, attempts, balance } = deps()
  mountRoutes({ webServer: web }, { repository, attempts, balance, clientId: 'cid', exchange: async () => ({ access: 'a', expires: 1 }) })
  const res = fakeResponse()
  const req = fakeRequest({ method: 'GET', url: '/plugins/openai-subscription/status', origin: 'http://localhost:1234' })
  await findRoute(web, '/status').handler(req, res)
  assert.equal(res.state.status, 200)
  const body = JSON.parse(res.state.body)
  assert.equal(body.ok, true)
  assert.equal(body.data.configured, false)
})

test('status route includes provider config when provided', async () => {
  const web = fakeWebServer()
  const { repository, attempts, balance } = deps()
  mountRoutes({ webServer: web }, { repository, attempts, balance, config: { provider: { defaultModel: 'gpt-5', reasoningEffort: 'high' } }, clientId: 'cid', exchange: async () => ({ access: 'a', expires: 1 }) })
  const res = fakeResponse()
  const req = fakeRequest({ method: 'GET', url: '/plugins/openai-subscription/status', origin: 'http://localhost:1234' })
  await findRoute(web, '/status').handler(req, res)
  assert.equal(res.state.status, 200)
  const body = JSON.parse(res.state.body)
  assert.equal(body.data.provider.defaultModel, 'gpt-5')
  assert.equal(body.data.provider.reasoningEffort, 'high')
})

test('oauth start route returns an auth url', async () => {
  const web = fakeWebServer()
  const { repository, attempts, balance } = deps()
  mountRoutes({ webServer: web }, { repository, attempts, balance, clientId: 'cid', exchange: async () => ({ access: 'a', refresh: 'r', expires: Date.now() + 1000, idToken: 'x.y.z' }) })
  const res = fakeResponse()
  const req = fakeRequest({ method: 'POST', url: '/plugins/openai-subscription/oauth/start', origin: 'http://localhost:1234', body: '{}' })
  await findRoute(web, '/oauth/start').handler(req, res)
  assert.equal(res.state.status, 200)
  const body = JSON.parse(res.state.body)
  assert.equal(body.ok, true)
  assert.match(body.data.url, /^https:\/\/auth\.openai\.com\/oauth\/authorize\?/)
  attempts.get(body.data.attemptId)?.cancel()
})

test('oauth code route accepts a manual code', async () => {
  const web = fakeWebServer()
  const { repository, attempts, balance } = deps()
  const header = Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url')
  const bodyPayload = Buffer.from(JSON.stringify({ chatgpt_account_id: 'acct_1' })).toString('base64url')
  const idToken = `${header}.${bodyPayload}.sig`
  mountRoutes({ webServer: web }, { repository, attempts, balance, clientId: 'cid', exchange: async () => ({ access: 'a', refresh: 'r', expires: Date.now() + 1000, idToken }) })
  const startRes = fakeResponse()
  const startReq = fakeRequest({ method: 'POST', url: '/plugins/openai-subscription/oauth/start', origin: 'http://localhost:1234', body: '{}' })
  await findRoute(web, '/oauth/start').handler(startReq, startRes)
  const started = JSON.parse(startRes.state.body).data
  const attempt = attempts.get(started.attemptId)
  const callbackUrl = `${started.redirectUri}?code=manual&state=${attempt.state}`
  const res = fakeResponse()
  const req = fakeRequest({ method: 'POST', url: '/plugins/openai-subscription/oauth/code', origin: 'http://localhost:1234', body: JSON.stringify({ attemptId: started.attemptId, input: callbackUrl }) })
  await findRoute(web, '/oauth/code').handler(req, res)
  assert.equal(res.state.status, 200)
  const grant = await attempt.result()
  assert.equal(grant.access, 'a')
  await attempts.dispose()
})

test('logout route deletes credential', async () => {
  const web = fakeWebServer()
  const { repository, attempts, balance } = deps()
  await repository.write({ schemaVersion: 1, type: 'oauth', access: 'a', refresh: 'r', expires: Date.now() + 1000, accountId: 'acct_1' })
  mountRoutes({ webServer: web }, { repository, attempts, balance, clientId: 'cid', exchange: async () => ({ access: 'a', expires: 1 }) })
  const res = fakeResponse()
  const req = fakeRequest({ method: 'POST', url: '/plugins/openai-subscription/logout', origin: 'http://localhost:1234', body: '{}' })
  await findRoute(web, '/logout').handler(req, res)
  assert.equal(res.state.status, 200)
  assert.equal(await repository.read(), undefined)
})

test('untrusted origin returns 403', async () => {
  const web = fakeWebServer()
  const { repository, attempts, balance } = deps()
  mountRoutes({ webServer: web }, { repository, attempts, balance, clientId: 'cid', exchange: async () => ({ access: 'a', expires: 1 }) })
  const res = fakeResponse()
  const req = fakeRequest({ method: 'GET', url: '/plugins/openai-subscription/status', origin: 'http://evil.example' })
  await findRoute(web, '/status').handler(req, res)
  assert.equal(res.state.status, 403)
})
