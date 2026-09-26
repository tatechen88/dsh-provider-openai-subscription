import test from 'node:test'
import assert from 'node:assert/strict'
import { startCallbackServer, CallbackServerError } from '../src/oauth/callback-server.js'

test('callback server receives a valid code and state', async () => {
  const onCode = []
  const onError = []
  const server = await startCallbackServer({ port: 0, path: '/auth/callback', expectedState: 'state-1', onCode: (code, state) => onCode.push({ code, state }), onError: (error) => onError.push(error) })
  try {
    const port = server.ports[0]
    const response = await fetch(`http://127.0.0.1:${port}/auth/callback?code=abc&state=state-1`)
    assert.equal(response.status, 200)
    assert.deepEqual(onCode, [{ code: 'abc', state: 'state-1' }])
    assert.equal(onError.length, 0)
  } finally {
    await server.close()
  }
})

test('a stray mismatched-state probe is answered, not obeyed', async () => {
  // A prefetch, a scanner, or another process's leftover tab carries the wrong
  // state. It is not the sign-in failing, so it must not fail the attempt —
  // only the callback whose state matches may settle anything.
  const codes = []
  const errors = []
  const server = await startCallbackServer({ port: 0, path: '/auth/callback', expectedState: 'expected', onCode: (code, state) => codes.push({ code, state }), onError: (error) => errors.push(error) })
  try {
    const port = server.ports[0]
    const probe = await fetch(`http://127.0.0.1:${port}/auth/callback?code=abc&state=wrong`)
    assert.equal(probe.status, 400)
    assert.deepEqual(codes, [], 'a probe must not consume a code')
    assert.deepEqual(errors, [], 'a probe must not fail the attempt')

    // The real callback still works afterwards.
    const real = await fetch(`http://127.0.0.1:${port}/auth/callback?code=def&state=expected`)
    assert.equal(real.status, 200)
    assert.deepEqual(codes, [{ code: 'def', state: 'expected' }])
    assert.deepEqual(errors, [])
  } finally {
    await server.close()
  }
})

test('callback server rejects missing code', async () => {
  const errors = []
  const server = await startCallbackServer({ port: 0, path: '/auth/callback', expectedState: 'expected', onCode: () => {}, onError: (error) => errors.push(error) })
  try {
    const port = server.ports[0]
    const response = await fetch(`http://127.0.0.1:${port}/auth/callback?state=expected`)
    assert.equal(response.status, 400)
    assert.equal(errors.length, 0)
  } finally {
    await server.close()
  }
})

test('callback server rejects wrong path with 404', async () => {
  const server = await startCallbackServer({ port: 0, path: '/auth/callback', expectedState: 'expected', onCode: () => {}, onError: () => {} })
  try {
    const port = server.ports[0]
    const response = await fetch(`http://127.0.0.1:${port}/other`)
    assert.equal(response.status, 404)
  } finally {
    await server.close()
  }
})

test('startCallbackServer rejects invalid port', async () => {
  await assert.rejects(
    startCallbackServer({ port: -1, path: '/auth/callback', expectedState: 's', onCode: () => {}, onError: () => {} }),
    (error) => error instanceof CallbackServerError && error.code === 'invalid-port',
  )
})
