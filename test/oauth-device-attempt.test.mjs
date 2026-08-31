import test from 'node:test'
import assert from 'node:assert/strict'
import { DeviceOAuthAttempt, DeviceOAuthAttemptManager } from '../src/oauth/device-attempt.js'
import { CredentialRepository } from '../src/credentials/repository.js'
import { CREDENTIAL_KEY } from '../src/constants.js'

function fakeProvider() {
  const records = new Map()
  return {
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
}

function idToken(accountId) {
  const header = Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url')
  const body = Buffer.from(JSON.stringify({ chatgpt_account_id: accountId, email: 'User@Example.com' })).toString('base64url')
  return `${header}.${body}.sig`
}

function fakeFetch() {
  let polls = 0
  return async (url) => {
    if (url.includes('/usercode')) {
      return new Response(JSON.stringify({ device_auth_id: 'd1', user_code: 'ABC-123', interval: 0 }), { status: 200 })
    }
    polls += 1
    if (polls === 1) return new Response(JSON.stringify({ error: { code: 'deviceauth_authorization_pending' } }), { status: 400 })
    return new Response(JSON.stringify({ authorization_code: 'device-code', code_verifier: 'device-verifier' }), { status: 200 })
  }
}

test('DeviceOAuthAttempt completes and persists grant', async () => {
  const provider = fakeProvider()
  const repository = new CredentialRepository(provider)
  const attempt = new DeviceOAuthAttempt({
    clientId: 'cid',
    repository,
    fetchImpl: fakeFetch(),
    timeoutSeconds: 10,
    exchange: async ({ code, redirectUri, codeVerifier }) => {
      assert.equal(code, 'device-code')
      assert.equal(codeVerifier, 'device-verifier')
      assert.ok(redirectUri.includes('auth.openai.com'))
      return { access: 'at', refresh: 'rt', expires: Date.now() + 1000, idToken: idToken('acct_1') }
    },
  })
  const info = await attempt.start()
  assert.equal(info.userCode, 'ABC-123')
  attempt.run()
  const grant = await attempt.result()
  assert.equal(grant.access, 'at')
  assert.equal(grant.accountId, 'acct_1')
  const stored = await provider.readRecord(CREDENTIAL_KEY)
  assert.equal(stored.kind, 'grant')
  assert.equal(stored.payload.refresh, 'rt')
})

test('DeviceOAuthAttemptManager creates and disposes', async () => {
  const repository = new CredentialRepository(fakeProvider())
  const manager = new DeviceOAuthAttemptManager({
    clientId: 'cid',
    repository,
    fetchImpl: fakeFetch(),
    timeoutSeconds: 10,
    exchange: async () => ({ access: 'at', refresh: 'rt', expires: Date.now() + 1000, idToken: idToken('a') }),
  })
  const info = await manager.create()
  assert.equal(manager.get(info.attemptId).status, 'waiting')
  await manager.dispose()
  assert.equal(manager.get(info.attemptId), undefined)
})

test('DeviceOAuthAttempt cancel rejects result', async () => {
  const repository = new CredentialRepository(fakeProvider())
  const attempt = new DeviceOAuthAttempt({
    clientId: 'cid',
    repository,
    fetchImpl: async (url) => {
      if (url.includes('/usercode')) {
        return new Response(JSON.stringify({ device_auth_id: 'd1', user_code: 'ABC-123', interval: 0 }), { status: 200 })
      }
      throw new Error('poll should not run')
    },
    exchange: async () => { throw new Error('unused') },
  })
  await attempt.start()
  attempt.cancel()
  await assert.rejects(attempt.result(), (error) => error.code === 'cancelled')
})
