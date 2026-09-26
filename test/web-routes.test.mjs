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

/**
 * The decision DSH's Connection service makes, as `api-request-trust.ts`
 * documents it: a Host that is neither loopback nor a declared authority is
 * refused, an attached Origin must be exactly that authority, and a browser
 * session decides 401. The plugin owns only the delegation, so the stub stands
 * in for the deployment's fence and records what it was asked.
 * @param {object} options
 * @param {string[]} [options.trustedHosts] - authorities this deployment serves.
 * @param {boolean} [options.authenticated] - whether the session cookie is valid.
 * @returns {(request: {headers: object}) => 401|403|undefined}
 */
function dshFence({ trustedHosts = [], authenticated = false } = {}) {
  return (request) => {
    const host = request.headers.host
    if (host === undefined) return 403
    let hostUrl
    try {
      hostUrl = new URL(`http://${host}`)
    } catch {
      return 403
    }
    const loopback = hostUrl.hostname === 'localhost' || hostUrl.hostname === '[::1]'
      || (hostUrl.hostname.startsWith('127.') && hostUrl.hostname.split('.').length === 4)
    if (!loopback && !trustedHosts.includes(hostUrl.host)) return 403
    if (request.headers['sec-fetch-site'] === 'cross-site') return 403
    const origin = request.headers.origin
    if (origin !== undefined) {
      try {
        if (new URL(origin).host !== hostUrl.host) return 403
      } catch {
        return 403
      }
    }
    return authenticated ? undefined : 401
  }
}

test('a deployment fence decides a trusted non-loopback Host, an untrusted one, a cross-origin one, and a missing Host', async () => {
  const { repository, attempts, balance } = deps()
  const call = async (headers, { authenticated = false } = {}) => {
    const web = fakeWebServer()
    mountRoutes({ webServer: web }, {
      repository,
      attempts,
      balance,
      clientId: 'cid',
      exchange: async () => ({ access: 'a', expires: 1 }),
      authorize: dshFence({ trustedHosts: ['phone.example'], authenticated }),
    })
    const response = fakeResponse()
    await findRoute(web, '/status').handler(
      { method: 'GET', url: '/plugins/openai-subscription/status', headers, [Symbol.asyncIterator]: () => [][Symbol.iterator]() },
      response,
    )
    return response
  }

  // The authority the tunnel serves: in the fence, but no session yet.
  const trusted = await call({ host: 'phone.example', origin: 'https://phone.example' })
  assert.equal(trusted.state.status, 401)
  assert.match(trusted.state.body, /authentication required/)

  // Same authority with a valid browser session reaches the route.
  const signedIn = await call({ host: 'phone.example', origin: 'https://phone.example' }, { authenticated: true })
  assert.equal(signedIn.state.status, 200)

  // Loopback stays reachable without the deployment declaring it.
  const loopback = await call({ host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080' })
  assert.equal(loopback.state.status, 401)

  const untrusted = await call({ host: 'evil.example', origin: 'https://evil.example' })
  assert.equal(untrusted.state.status, 403)
  assert.match(untrusted.state.body, /untrusted origin/)

  const crossOrigin = await call({ host: 'phone.example', origin: 'https://evil.example' })
  assert.equal(crossOrigin.state.status, 403)
  assert.match(crossOrigin.state.body, /untrusted origin/)

  const noHost = await call({ origin: 'https://phone.example' })
  assert.equal(noHost.state.status, 403)
  assert.match(noHost.state.body, /untrusted origin/)
})

test('a supplied trust fence decides the request instead of sameOrigin', async () => {
  const { repository, attempts, balance } = deps()
  const seen = []
  const web = fakeWebServer()
  mountRoutes({ webServer: web }, {
    repository,
    attempts,
    balance,
    clientId: 'cid',
    exchange: async () => ({ access: 'a', expires: 1 }),
    authorize: (request) => {
      seen.push(request.headers.host)
      // No Origin at all: the local same-origin check would refuse this, the
      // deployment fence is the authority instead.
      return request.headers['x-allow'] === 'yes' ? undefined : 401
    },
  })

  const denied = fakeResponse()
  await findRoute(web, '/status').handler(
    { method: 'GET', url: '/plugins/openai-subscription/status', headers: { host: 'h', 'x-allow': 'no' }, [Symbol.asyncIterator]: () => [][Symbol.iterator]() },
    denied,
  )
  assert.equal(denied.state.status, 401)
  assert.match(denied.state.body, /authentication required/)
  assert.deepEqual(seen, ['h'], 'the fence sees the request before anything else runs')

  const allowed = fakeResponse()
  await findRoute(web, '/status').handler(
    { method: 'GET', url: '/plugins/openai-subscription/status', headers: { host: 'h', 'x-allow': 'yes' }, [Symbol.asyncIterator]: () => [][Symbol.iterator]() },
    allowed,
  )
  assert.equal(allowed.state.status, 200)
})

test('a route that cannot register leaves no route behind', () => {
  const { repository, attempts, balance } = deps()
  const routes = []
  let calls = 0
  const web = {
    routes,
    register(route) {
      calls += 1
      // The web server refuses a duplicate exact path; the third registration
      // fails after two have already succeeded.
      if (calls === 3) throw new Error(`webserver: duplicate exact route "${route.path}"`)
      routes.push(route)
      return () => {
        const index = routes.indexOf(route)
        if (index >= 0) routes.splice(index, 1)
      }
    },
  }
  assert.throws(
    () => mountRoutes({ webServer: web }, { repository, attempts, balance, clientId: 'cid', exchange: async () => ({ access: 'a', expires: 1 }) }),
    /duplicate exact route/,
  )
  assert.deepEqual(routes, [], 'a failed mount must release the routes it already registered')
})

test('mountRoutes registers model routes when listModels is provided', async () => {
  const web = fakeWebServer()
  const { repository, attempts, balance } = deps()
  const devices = { create: async () => ({}), get: () => undefined, dispose: async () => {} }
  let invalidated = 0
  const listModels = async () => [{ id: 'gpt-5', name: 'GPT-5' }]
  const invalidateModels = () => { invalidated += 1 }
  mountRoutes({ webServer: web }, { repository, attempts, devices, balance, listModels, invalidateModels, clientId: 'cid', exchange: async () => ({ access: 'a', expires: 1 }) })
  const res = fakeResponse()
  const req = fakeRequest({ method: 'GET', url: '/plugins/openai-subscription/models', origin: 'http://localhost:1234' })
  await findRoute(web, '/models').handler(req, res)
  assert.equal(res.state.status, 200)
  const body = JSON.parse(res.state.body)
  assert.deepEqual(body.data, [{ id: 'gpt-5', name: 'GPT-5' }])

  // A refresh that answers with the cached catalogue is not a refresh.
  const refreshed = fakeResponse()
  await findRoute(web, '/models/refresh').handler(
    fakeRequest({ method: 'POST', url: '/plugins/openai-subscription/models/refresh', origin: 'http://localhost:1234' }),
    refreshed,
  )
  assert.equal(refreshed.state.status, 200)
  assert.equal(invalidated, 1, 'the refresh drops the cached catalogue first')
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
