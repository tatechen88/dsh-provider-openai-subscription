import test from 'node:test'
import assert from 'node:assert/strict'
import { startDeviceAuth, pollDeviceAuth, DEVICE_USER_CODE_URL, DEVICE_TOKEN_URL, DeviceFlowError } from '../src/oauth/device-client.js'

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

test('startDeviceAuth parses device response', async () => {
  const device = await startDeviceAuth({
    clientId: 'cid',
    fetchImpl: async (url, init) => {
      assert.equal(url, DEVICE_USER_CODE_URL)
      assert.equal(JSON.parse(init.body).client_id, 'cid')
      return jsonResponse(200, { device_auth_id: 'd1', user_code: 'ABC-123', interval: '2' })
    },
  })
  assert.equal(device.deviceAuthId, 'd1')
  assert.equal(device.userCode, 'ABC-123')
  assert.equal(device.intervalSeconds, 2)
})

test('startDeviceAuth maps 404 to not-enabled', async () => {
  await assert.rejects(
    startDeviceAuth({ clientId: 'cid', fetchImpl: async () => jsonResponse(404, {}) }),
    (error) => error instanceof DeviceFlowError && error.code === 'not-enabled',
  )
})

test('pollDeviceAuth completes on first success', async () => {
  const value = await pollDeviceAuth({
    device: { deviceAuthId: 'd1', userCode: 'ABC', intervalSeconds: 1 },
    fetchImpl: async (url) => {
      assert.equal(url, DEVICE_TOKEN_URL)
      return jsonResponse(200, { authorization_code: 'auth-code', code_verifier: 'verifier' })
    },
  })
  assert.deepEqual(value, { authorizationCode: 'auth-code', codeVerifier: 'verifier' })
})

test('pollDeviceAuth handles pending then complete', async () => {
  let calls = 0
  const value = await pollDeviceAuth({
    device: { deviceAuthId: 'd1', userCode: 'ABC', intervalSeconds: 0 },
    timeoutSeconds: 10,
    fetchImpl: async () => {
      calls += 1
      if (calls === 1) return jsonResponse(403, {})
      return jsonResponse(200, { authorization_code: 'auth-code', code_verifier: 'verifier' })
    },
  })
  assert.equal(calls, 2)
  assert.equal(value.authorizationCode, 'auth-code')
})

test('pollDeviceAuth maps slow_down to success after interval increase', async () => {
  let calls = 0
  const value = await pollDeviceAuth({
    device: { deviceAuthId: 'd1', userCode: 'ABC', intervalSeconds: 0 },
    timeoutSeconds: 10,
    fetchImpl: async () => {
      calls += 1
      if (calls === 1) return jsonResponse(400, { error: { code: 'slow_down' }, interval: 2 })
      return jsonResponse(200, { authorization_code: 'auth-code', code_verifier: 'verifier' })
    },
  })
  assert.equal(calls, 2)
  assert.equal(value.authorizationCode, 'auth-code')
})
