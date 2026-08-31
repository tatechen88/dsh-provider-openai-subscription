import test from 'node:test'
import assert from 'node:assert/strict'
import { OAuthAttempt, OAuthAttemptManager } from '../src/oauth/attempt-manager.js'
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

test('OAuthAttempt completes through manual code and persists grant', async () => {
  const provider = fakeProvider()
  const repository = new CredentialRepository(provider)
  const attempt = new OAuthAttempt({
    clientId: 'cid',
    repository,
    port: 0,
    exchange: async ({ code, redirectUri, codeVerifier }) => {
      assert.equal(code, 'manual-code')
      assert.ok(redirectUri.startsWith('http://localhost:'))
      assert.ok(codeVerifier.length > 0)
      return { access: 'at', refresh: 'rt', expires: Date.now() + 3600 * 1000, idToken: idToken('acct_1') }
    },
  })
  const started = await attempt.start()
  assert.equal(started.url.includes('response_type=code'), true)
  assert.equal(started.url.includes('client_id=cid'), true)
  const callbackUrl = `${started.redirectUri}?code=manual-code&state=${attempt.state}`
  const submitted = attempt.submitManualCode(callbackUrl)
  assert.deepEqual(submitted, { ok: true })
  const grant = await attempt.result()
  assert.equal(grant.access, 'at')
  assert.equal(grant.refresh, 'rt')
  assert.equal(grant.accountId, 'acct_1')
  const stored = await provider.readRecord(CREDENTIAL_KEY)
  assert.equal(stored.kind, 'grant')
  assert.equal(stored.payload.accountId, 'acct_1')
})

test('OAuthAttempt rejects state-mismatched manual URL', async () => {
  const repository = new CredentialRepository(fakeProvider())
  const attempt = new OAuthAttempt({
    clientId: 'cid',
    repository,
    port: 0,
    exchange: async () => ({ access: 'at', refresh: 'rt', expires: Date.now() + 1000, idToken: idToken('a') }),
  })
  const started = await attempt.start()
  const result = attempt.submitManualCode(`${started.redirectUri}?code=bad&state=wrong`)
  assert.deepEqual(result, { ok: false, error: 'state-mismatch' })
  await attempt.cancel()
  await assert.rejects(attempt.result(), (error) => error.code === 'cancelled')
})

test('OAuthAttempt cancel rejects result', async () => {
  const repository = new CredentialRepository(fakeProvider())
  const attempt = new OAuthAttempt({
    clientId: 'cid',
    repository,
    port: 0,
    exchange: async () => { throw new Error('unused') },
  })
  await attempt.start()
  attempt.cancel()
  await assert.rejects(attempt.result(), (error) => error.code === 'cancelled')
})

test('OAuthAttemptManager creates and disposes attempts', async () => {
  const repository = new CredentialRepository(fakeProvider())
  const manager = new OAuthAttemptManager({
    clientId: 'cid',
    repository,
    port: 0,
    exchange: async () => ({ access: 'at', refresh: 'rt', expires: Date.now() + 1000, idToken: idToken('a') }),
  })
  const started = await manager.create()
  assert.equal(manager.get(started.attemptId).status, 'waiting')
  await manager.dispose()
  assert.equal(manager.get(started.attemptId), undefined)
})
