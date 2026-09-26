import test from 'node:test'
import assert from 'node:assert/strict'

import { createOperations, DEFAULT_LOGIN_WAIT_MS } from '../src/operations.js'
import { toolOptions } from '../src/tools.js'

/**
 * The operations are what every surface ends up calling, so these tests are
 * about the promises it makes to them: nothing prompt-driven, a bounded wait
 * that does not cancel anything, and an honest report when a service is absent.
 */

function fakeAttempt() {
  return {
    id: 'attempt-1',
    status: 'waiting',
    cancelled: [],
    toJSON() {
      return { attemptId: this.id, status: this.status, url: 'https://auth.example/1' }
    },
    cancel(reason) {
      this.cancelled.push(reason)
      this.status = 'failed'
    },
  }
}

function fakeManagers(attempt = fakeAttempt()) {
  const manager = () => ({
    pending: () => (attempt.status === 'waiting' ? attempt : undefined),
    get: (id) => (id === attempt.id ? attempt : undefined),
  })
  return { attempt, attempts: manager(), devices: manager() }
}

function fakeRepository({ configured = false } = {}) {
  return {
    writes: 0,
    async status() {
      return { configured, writable: true }
    },
    async delete() {
      this.writes += 1
    },
  }
}

test('status joins the credential, the provider defaults and any live attempt', async () => {
  const { attempts, devices, attempt } = fakeManagers()
  const operations = createOperations({
    repository: fakeRepository({ configured: true }),
    attempts,
    devices,
    authorization: { describe: () => ({ inFlight: true }) },
    authorizationKey: 'llm-openai-subscription/default',
    config: { provider: { defaultModel: 'gpt-6-luna', reasoningEffort: 'max' } },
  })
  const status = await operations.status()
  assert.equal(status.provider, 'openai-subscription')
  assert.equal(status.configured, true)
  assert.deepEqual(status.provider_defaults, { defaultModel: 'gpt-6-luna', reasoningEffort: 'max' })
  assert.equal(status.login.inFlight, true)
  assert.equal(status.login.attempt.attemptId, attempt.id)
})

test('login reports an absent seam instead of pretending to start', async () => {
  const { attempts, devices } = fakeManagers()
  const operations = createOperations({ repository: fakeRepository(), attempts, devices, authorizationKey: 'k' })
  assert.deepEqual(await operations.login(), {
    status: 'unavailable',
    reason: 'no authorization service is mounted in this deployment',
  })
})

test('login refuses to start a second attempt while one is in flight', async () => {
  const { attempts, devices } = fakeManagers()
  let began = 0
  const operations = createOperations({
    repository: fakeRepository(),
    attempts,
    devices,
    authorization: {
      describe: () => ({ inFlight: true }),
      begin: async () => {
        began += 1
        return { status: 'authorized' }
      },
    },
    authorizationKey: 'k',
  })
  const result = await operations.login({ method: 'oauth' })
  assert.equal(result.status, 'in-flight')
  assert.equal(result.attempt.attemptId, 'attempt-1')
  assert.equal(began, 0, 'the seam refuses a second attempt, so it is never called')
})

test('login reports the notices a surface must render, and a finished sign-in', async () => {
  const { attempts, devices } = fakeManagers()
  const operations = createOperations({
    repository: fakeRepository({ configured: true }),
    attempts,
    devices,
    authorization: {
      describe: () => ({ inFlight: false }),
      begin: async ({ interaction }) => {
        interaction.notify({ message: 'open this', url: 'https://auth.example/1' })
        return { status: 'authorized' }
      },
    },
    authorizationKey: 'k',
  })
  const result = await operations.login({ method: 'oauth' })
  assert.equal(result.status, 'authorized')
  assert.equal(result.notices.length, 1)
  assert.equal(result.credential.configured, true)
})

test('a caller that stops waiting leaves the attempt running', async () => {
  const { attempts, devices, attempt } = fakeManagers()
  const operations = createOperations({
    repository: fakeRepository(),
    attempts,
    devices,
    // No authorization outcome ever arrives: the human is still in the browser.
    // `inFlight` is only true from the seam's point of view *after* this call
    // begins, which is why the check above happens before it.
    authorization: {
      describe: () => ({ inFlight: false }),
      begin: () => new Promise(() => {}),
    },
    authorizationKey: 'k',
    sleep: async () => 'timeout',
  })
  const result = await operations.login({ method: 'oauth' })
  assert.equal(result.status, 'pending')
  assert.equal(result.attempt.attemptId, attempt.id)
  assert.deepEqual(attempt.cancelled, [], 'stopping the wait is not a withdrawal')
  assert.match(result.hint, /open the link/)
  assert.equal(DEFAULT_LOGIN_WAIT_MS, 60_000)
})

test('a refused flow is reported as a failure, and a declined one as cancelled', async () => {
  const { attempts, devices } = fakeManagers()
  const failing = createOperations({
    repository: fakeRepository(),
    attempts,
    devices,
    authorization: {
      describe: () => ({ inFlight: false }),
      begin: async () => {
        throw new Error('authorization flow for "k" resolved without committing a credential record')
      },
    },
    authorizationKey: 'k',
  })
  const failed = await failing.login()
  assert.equal(failed.status, 'failed')
  assert.match(failed.error, /without committing/)

  const cancelling = createOperations({
    repository: fakeRepository(),
    attempts,
    devices,
    authorization: {
      describe: () => ({ inFlight: false }),
      begin: async () => ({ status: 'cancelled' }),
    },
    authorizationKey: 'k',
  })
  assert.equal((await cancelling.login()).status, 'cancelled')
})

test('logout forgets the record and stops anything waiting', async () => {
  const { attempts, devices, attempt } = fakeManagers()
  const repository = fakeRepository({ configured: true })
  let cleared = 0
  const operations = createOperations({
    repository,
    attempts,
    devices,
    balance: { clear: () => { cleared += 1 } },
    authorizationKey: 'k',
  })
  assert.deepEqual(await operations.logout(), { status: 'signed-out' })
  assert.equal(repository.writes, 1)
  assert.equal(cleared, 1)
  assert.deepEqual(attempt.cancelled, ['signed out'])
})

test('cancelLogin stops the attempt without touching the credential', async () => {
  const { attempts, devices, attempt } = fakeManagers()
  const repository = fakeRepository({ configured: true })
  const operations = createOperations({ repository, attempts, devices, authorizationKey: 'k' })
  assert.deepEqual(operations.cancelLogin(), { status: 'cancelled' })
  assert.deepEqual(attempt.cancelled, ['cancelled by the caller'])
  assert.equal(repository.writes, 0)
})

test('the tools describe the operations a chat can perform', () => {
  const calls = []
  const operations = {
    status: async () => ({ configured: true }),
    login: async (options) => {
      calls.push(['login', options])
      return { status: 'pending' }
    },
    logout: async () => ({ status: 'signed-out' }),
    quota: async (options) => {
      calls.push(['quota', options])
      return { status: 'ready' }
    },
    usage: async (options) => {
      calls.push(['usage', options])
      return { status: 'ok' }
    },
  }
  const options = toolOptions({ operations })
  assert.deepEqual(options.map((entry) => entry.name), [
    'openai_subscription_status',
    'openai_subscription_login',
    'openai_subscription_logout',
    'openai_subscription_quota',
    'usage_meter_report',
  ])
  // A model reads these: an empty or vague description is a broken tool.
  for (const entry of options) {
    assert.ok(entry.description.length > 60, `${entry.name} needs a real description`)
    assert.equal(typeof entry.execute, 'function')
    assert.equal(typeof entry.output.render, 'function')
    assert.equal(entry.output.render({}, { ok: true })[0].type, 'text')
  }
  const login = options.find((entry) => entry.name.endsWith('_login'))
  assert.deepEqual(Object.keys(login.parameters), ['method', 'wait_seconds'])
  const quota = options.find((entry) => entry.name.endsWith('_quota'))
  assert.deepEqual(Object.keys(quota.parameters), ['refresh'])
})

test('the quota and usage tools translate their arguments', async () => {
  const calls = []
  const options = toolOptions({
    operations: {
      status: async () => ({}),
      login: async () => ({}),
      logout: async () => ({}),
      quota: async (input) => {
        calls.push(['quota', input])
        return {}
      },
      usage: async (input) => {
        calls.push(['usage', input])
        return {}
      },
    },
  })
  const quota = options.find((entry) => entry.name.endsWith('_quota'))
  await quota.execute({ refresh: true })
  await quota.execute({})

  const usage = options.find((entry) => entry.name === 'usage_meter_report')
  // The session slice is only meaningful for the session this call belongs to,
  // so the tool takes it from the execution rather than from the model.
  await usage.execute({ scope: 'session' }, { agent: { session: { id: 'session-1' } } })
  await usage.execute({}, {})
  await usage.execute({ scope: 'month' }, undefined)

  assert.deepEqual(calls, [
    ['quota', { refresh: true }],
    ['quota', { refresh: false }],
    ['usage', { scope: 'session', sessionId: 'session-1' }],
    ['usage', {}],
    ['usage', { scope: 'month' }],
  ])
})

test('the login tool clamps its wait and passes the method through', async () => {
  const calls = []
  const options = toolOptions({
    operations: { status: async () => ({}), login: async (input) => { calls.push(input); return {} }, logout: async () => ({}) },
  })
  const login = options.find((entry) => entry.name.endsWith('_login'))
  await login.execute({ method: 'device', wait_seconds: 5 })
  await login.execute({ wait_seconds: 100_000 })
  await login.execute({})
  assert.deepEqual(calls, [{ method: 'device', waitMs: 5_000 }, { waitMs: 600_000 }, {}])
})

test('quota reports the subscription windows, and says so when the meter is absent', async () => {
  const { attempts, devices } = fakeManagers()
  const forced = []
  const operations = createOperations({
    repository: fakeRepository(),
    attempts,
    devices,
    authorizationKey: 'k',
    meter: {
      openaiQuota: async (options) => {
        forced.push(options)
        return { status: 'ready', plan: 'plus', windows: [{ id: 'primary', remainingPercent: 62.5, exhausted: false }] }
      },
    },
  })
  const snapshot = await operations.quota({ refresh: true })
  assert.equal(snapshot.provider, 'openai-subscription')
  assert.equal(snapshot.windows[0].remainingPercent, 62.5)
  assert.deepEqual(forced, [{ force: true }])

  const bare = createOperations({ repository: fakeRepository(), attempts, devices, authorizationKey: 'k' })
  assert.equal((await bare.quota()).status, 'unavailable')
})

test('the usage report is the numbers a model should read, not the whole view', async () => {
  const { attempts, devices } = fakeManagers()
  const seen = []
  const operations = createOperations({
    repository: fakeRepository(),
    attempts,
    devices,
    authorizationKey: 'k',
    meter: {
      service: {
        view: (scope) => {
          seen.push(scope)
          // The real shape, copied from `UsageMeterService.view()`: the estimate's
          // terms sit under `pricing`. A fake that floats them to the top level
          // is what let a wrong read pass — the tool then returned `undefined`
          // fields and the harness refused the whole call.
          return {
            generatedAt: 1,
            account: { kind: 'personal', declared: true },
            display: { currency: 'CNY', timeZone: 'system' },
            privacy: { hideBalance: false, hideCost: false },
            deepseek: { status: 'ready' },
            pricing: {
              public: { scheduleId: 'x' },
              estimated: true,
              basis: 'request-start-assumption',
              unpricedModels: ['brand-new-model'],
              band: { id: 'offPeak' },
            },
            metered: [{ provider: 'deepseek-official' }],
            usage: {
              session: { calls: 2, amountMicros: 1000 },
              today: { calls: 9, amountMicros: 962828 },
              month: { calls: 40, amountMicros: 5000000 },
            },
          }
        },
      },
    },
  })

  const today = await operations.usage({ sessionId: 'session-1', scope: 'today' })
  assert.deepEqual(seen, [{ sessionId: 'session-1' }])
  assert.equal(today.usage.today.amountMicros, 962828)
  assert.equal('session' in today.usage, false, 'a scope report carries only the slice asked for')
  assert.deepEqual(today.unpricedModels, ['brand-new-model'])
  assert.equal('pricing' in today, false)
  assert.equal('metered' in today, false)

  const all = await operations.usage({ sessionId: 'session-1', scope: 'all' })
  assert.deepEqual(Object.keys(all.usage).sort(), ['month', 'session', 'today'])

  // Without a session there is no session slice to report, and asking for one
  // must not invent it.
  const noSession = await operations.usage({ scope: 'all' })
  assert.deepEqual(Object.keys(noSession.usage).sort(), ['month', 'today'])

  const bare = createOperations({ repository: fakeRepository(), attempts, devices, authorizationKey: 'k' })
  assert.equal((await bare.usage()).status, 'unavailable')
})