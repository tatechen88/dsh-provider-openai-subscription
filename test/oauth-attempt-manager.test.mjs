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

test('OAuthAttempt binds the literal callback port it is given', async () => {
  // The port reaches the redirect URI, so an operator whose default port is
  // unbindable (Windows dynamic exclusion ranges) must get exactly the port
  // they configured — not a substituted one.
  const repository = new CredentialRepository(fakeProvider())
  const attempt = new OAuthAttempt({
    clientId: 'cid',
    repository,
    port: 1537,
    exchange: async () => { throw new Error('never exchanged') },
  })
  try {
    const started = await attempt.start()
    assert.equal(started.redirectUri, 'http://localhost:1537/auth/callback')
    assert.equal(attempt.port, 1537)
    assert.match(started.url, /redirect_uri=http%3A%2F%2Flocalhost%3A1537%2Fauth%2Fcallback/)
  } finally {
    attempt.cancel('test teardown')
    await attempt.callbackServer?.close()
  }
})

test('OAuthAttempt does not substitute a port when the configured one is unbindable', async () => {
  // A reserved or occupied port must surface as a hard failure: silently moving
  // to another port would send the browser to a redirect URI the operator never
  // configured, which is exactly the failure this option exists to avoid.
  // 65535 is a valid literal port; the attempt must either bind *that* port or
  // fail loudly naming it — never a different one.
  const repository = new CredentialRepository(fakeProvider())
  const attempt = new OAuthAttempt({
    clientId: 'cid',
    repository,
    port: 65_535,
    exchange: async () => { throw new Error('never exchanged') },
  })
  try {
    const started = await attempt.start()
    assert.equal(started.redirectUri, 'http://localhost:65535/auth/callback')
  } catch (error) {
    assert.match(String(error.message), /65535/)
  } finally {
    attempt.cancel('test teardown')
    await attempt.callbackServer?.close()
  }
})

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
