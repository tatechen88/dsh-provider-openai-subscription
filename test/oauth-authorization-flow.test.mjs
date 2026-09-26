import test from 'node:test'
import assert from 'node:assert/strict'

import { createAuthorizationFlow, FLOW_METHODS } from '../src/oauth/authorization-flow.js'

/**
 * The flow exists to translate "a surface wants this credential" into the
 * attempt managers this plugin already had. What matters is therefore the
 * conversation it has with the seam's session, and that a withdrawal is not
 * turned into an error the caller never asked for.
 */

/** A loopback attempt stand-in the test drives by hand. */
function fakeLoopbackAttempt() {
  let resolveResult
  let rejectResult
  const result = new Promise((resolve, reject) => {
    resolveResult = resolve
    rejectResult = reject
  })
  void result.catch(() => {})
  const attempt = {
    id: 'attempt-1',
    status: 'waiting',
    url: 'https://auth.example/authorize?state=st-1',
    redirectUri: 'http://127.0.0.1:1455/auth/callback',
    submitted: [],
    cancelled: [],
    settled: undefined,
    resolveResult,
    rejectResult,
    submitManualCode(input) {
      this.submitted.push(input)
      return input === 'good' ? { ok: true } : { ok: false, error: 'no-code' }
    },
    cancel(reason) {
      this.cancelled.push(reason)
      rejectResult(new Error('cancelled'))
    },
    async result() {
      return result
    },
    toJSON() {
      return { attemptId: this.id, status: this.status, url: this.url }
    },
  }
  return attempt
}

function fakeDevices() {
  const attempt = {
    id: 'device-1',
    status: 'waiting',
    cancelled: [],
    cancel(reason) {
      this.cancelled.push(reason)
    },
    async result() {
      return { accountId: 'acct_device' }
    },
    toJSON() {
      return { attemptId: this.id, status: this.status }
    },
  }
  return {
    attempt,
    async create() {
      return {
        attemptId: attempt.id,
        verificationUri: 'https://auth.example/device',
        userCode: 'ABCD-1234',
        intervalSeconds: 5,
        expiresInSeconds: 900,
      }
    },
    get(id) {
      return id === attempt.id ? attempt : undefined
    },
    pending() {
      return attempt
    },
  }
}

function fakeAttempts(attempt) {
  return {
    attempt,
    async create() {
      return { attemptId: attempt.id, url: attempt.url, redirectUri: attempt.redirectUri }
    },
    get(id) {
      return id === attempt.id ? attempt : undefined
    },
    pending() {
      return attempt
    },
  }
}

/** A session stand-in; `prompt` only exists when the test wants one. */
function fakeSession({ method = 'oauth', answer, signal } = {}) {
  const notices = []
  return {
    notices,
    method,
    signal,
    commitCalls: 0,
    notify: (notice) => notices.push(notice),
    prompt: async (prompt) => {
      if (answer === undefined) throw new Error(`unexpected prompt: ${prompt.message}`)
      return answer
    },
  }
}

function flowFor({ attempts, devices }) {
  return createAuthorizationFlow({
    attempts,
    devices,
    repository: { write: async () => ({}) },
    clientId: 'client-1',
    exchange: async () => ({ access: 'at' }),
  })
}

test('the flow offers the methods this plugin can actually finish', () => {
  const flow = flowFor({ attempts: fakeAttempts(fakeLoopbackAttempt()), devices: fakeDevices() })
  assert.deepEqual(flow.methods.map((entry) => entry.id), ['oauth', 'manual', 'device'])
  assert.equal(flow.key, 'llm-openai-subscription/default')
  assert.ok(flow.label.length > 0)
})

test('the default method hands the human a link and waits for the callback', async () => {
  const attempt = fakeLoopbackAttempt()
  const flow = flowFor({ attempts: fakeAttempts(attempt), devices: fakeDevices() })
  const session = fakeSession({ method: 'oauth' })
  const running = flow.run(session)

  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(session.notices.length, 1)
  assert.equal(session.notices[0].url, attempt.url)
  assert.deepEqual(attempt.submitted, [], 'the default method never asks for a pasted code')

  attempt.resolveResult({ accountId: 'acct_1' })
  await running
  assert.deepEqual(attempt.cancelled, [])
})

test('the manual method asks for the pasted answer and refuses a bad one', async () => {
  const attempt = fakeLoopbackAttempt()
  const flow = flowFor({ attempts: fakeAttempts(attempt), devices: fakeDevices() })

  const accepted = fakeSession({ method: 'manual', answer: 'good' })
  const running = flow.run(accepted)
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(attempt.submitted, ['good'])
  attempt.resolveResult({ accountId: 'acct_1' })
  await running

  const bad = fakeLoopbackAttempt()
  const refusing = flowFor({ attempts: fakeAttempts(bad), devices: fakeDevices() })
  await assert.rejects(
    refusing.run(fakeSession({ method: 'manual', answer: 'nonsense' })),
    /refused: no-code/,
  )
  // The refusal must also close the attempt: leaving the listener up would block
  // the retry the human is about to make.
  assert.equal(bad.cancelled.length, 1)
})

test('the device method reports the code and finishes on the device attempt', async () => {
  const devices = fakeDevices()
  const flow = flowFor({ attempts: fakeAttempts(fakeLoopbackAttempt()), devices })
  const session = fakeSession({ method: 'device' })
  await flow.run(session)
  assert.equal(session.notices.length, 1)
  assert.equal(session.notices[0].code, 'ABCD-1234')
  assert.equal(session.notices[0].url, 'https://auth.example/device')
})

test('an unknown method falls back to the first one rather than failing', async () => {
  const attempt = fakeLoopbackAttempt()
  const flow = flowFor({ attempts: fakeAttempts(attempt), devices: fakeDevices() })
  const session = fakeSession({ method: 'nonsense' })
  const running = flow.run(session)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(session.notices.length, 1)
  attempt.resolveResult({ accountId: 'acct_1' })
  await running
})

test('a withdrawal stops the attempt without throwing at the seam', async () => {
  const attempt = fakeLoopbackAttempt()
  const flow = flowFor({ attempts: fakeAttempts(attempt), devices: fakeDevices() })
  const controller = new AbortController()
  const session = fakeSession({ method: 'oauth', signal: controller.signal })
  const running = flow.run(session)

  await new Promise((resolve) => setImmediate(resolve))
  controller.abort()
  // The seam has already answered `cancelled`; the flow must settle quietly.
  await running
  assert.deepEqual(attempt.cancelled, ['the caller withdrew the authorization attempt'])
})

test('a failed exchange reaches the caller as an error', async () => {
  const attempt = fakeLoopbackAttempt()
  const flow = flowFor({ attempts: fakeAttempts(attempt), devices: fakeDevices() })
  const running = flow.run(fakeSession({ method: 'oauth' }))
  await new Promise((resolve) => setImmediate(resolve))
  attempt.rejectResult(new Error('exchange refused'))
  await assert.rejects(running, /exchange refused/)
})

test('the flow refuses to be built without the pieces it drives', () => {
  assert.throws(
    () => createAuthorizationFlow({ devices: fakeDevices(), repository: {}, clientId: 'c', exchange: async () => ({}) }),
    /requires the attempt managers/,
  )
  assert.throws(
    () => createAuthorizationFlow({ attempts: fakeAttempts(fakeLoopbackAttempt()), devices: fakeDevices(), repository: {}, clientId: '', exchange: async () => ({}) }),
    /requires a client id/,
  )
  // The method list is the contract a surface reads; keep it frozen against
  // accidental edits in place.
  assert.equal(Object.isFrozen(FLOW_METHODS), true)
})
