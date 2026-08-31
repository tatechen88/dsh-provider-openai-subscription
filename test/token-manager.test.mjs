import test from 'node:test'
import assert from 'node:assert/strict'
import { TokenManager, TokenManagerError, isTerminalRefreshCode } from '../src/credentials/token-manager.js'
import { CredentialRepository } from '../src/credentials/repository.js'
import { parseGrant } from '../src/credentials/schema.js'
import { CREDENTIAL_KEY } from '../src/constants.js'

function fakeProvider(initial) {
  const records = new Map()
  if (initial !== undefined) records.set(CREDENTIAL_KEY, initial)
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

const now = () => 1786000000000

function repo(grant) {
  return new CredentialRepository(fakeProvider({ kind: 'grant', payload: grant }))
}

function grant(overrides = {}) {
  return parseGrant({
    schemaVersion: 1,
    type: 'oauth',
    access: 'at',
    refresh: 'rt',
    expires: now() + 10 * 60 * 1000,
    accountId: 'acct_123',
    obtainedAt: now(),
    ...overrides,
  })
}

test('getAccessSnapshot returns valid unexpired token without refresh', async () => {
  const manager = new TokenManager({ repository: repo(grant()), refreshFn: async () => { throw new Error('should not refresh') }, now })
  const snapshot = await manager.getAccessSnapshot()
  assert.equal(snapshot.accessToken, 'at')
  assert.equal(snapshot.accountId, 'acct_123')
})

test('getAccessSnapshot refreshes near-expiry token', async () => {
  const provider = fakeProvider({ kind: 'grant', payload: grant({ expires: now() + 1000 }) })
  const repository = new CredentialRepository(provider)
  let calls = 0
  const manager = new TokenManager({
    repository,
    now,
    refreshFn: async () => {
      calls += 1
      return { access: 'at-new', refresh: 'rt-new', expires: now() + 3600 * 1000, accountId: 'acct_123' }
    },
  })
  const snapshot = await manager.getAccessSnapshot()
  assert.equal(calls, 1)
  assert.equal(snapshot.accessToken, 'at-new')
  const stored = await repository.read()
  assert.equal(stored.refresh, 'rt-new')
  assert.equal(stored.needsReauth, undefined)
})

test('concurrent refresh shares one flight', async () => {
  let calls = 0
  const manager = new TokenManager({
    repository: repo(grant({ expires: now() - 1 })),
    now,
    refreshFn: async () => {
      calls += 1
      await new Promise((resolve) => setTimeout(resolve, 10))
      return { access: 'at-new', refresh: 'rt-new', expires: now() + 3600 * 1000, accountId: 'acct_123' }
    },
  })
  const [a, b] = await Promise.all([manager.refresh(), manager.refresh()])
  assert.equal(calls, 1)
  assert.equal(a.access, 'at-new')
  assert.equal(b.access, 'at-new')
})

test('terminal refresh error marks needsReauth', async () => {
  const repository = repo(grant({ expires: now() - 1 }))
  const manager = new TokenManager({
    repository,
    now,
    refreshFn: async () => {
      throw new TokenManagerError('invalid_grant', 'bad refresh')
    },
  })
  await assert.rejects(manager.refresh(), (error) => error instanceof TokenManagerError && error.code === 'invalid_grant')
  const stored = await repository.read()
  assert.equal(stored.needsReauth, true)
})

test('transient refresh error does not mark needsReauth', async () => {
  const repository = repo(grant({ expires: now() - 1 }))
  const manager = new TokenManager({
    repository,
    now,
    refreshFn: async () => {
      throw new TokenManagerError('upstream', 'temporary')
    },
  })
  await assert.rejects(manager.refresh(), (error) => error.code === 'upstream')
  assert.equal((await repository.read()).needsReauth, undefined)
})

test('getAccessSnapshot rejects when not signed in', async () => {
  const repository = new CredentialRepository(fakeProvider())
  const manager = new TokenManager({ repository, refreshFn: async () => { throw new Error('no') }, now })
  await assert.rejects(manager.getAccessSnapshot(), (error) => error instanceof TokenManagerError && error.code === 'not-signed-in')
})

test('getAccessSnapshot rejects when needsReauth', async () => {
  const manager = new TokenManager({
    repository: repo(grant({ needsReauth: true })),
    refreshFn: async () => { throw new Error('no') },
    now,
  })
  await assert.rejects(manager.getAccessSnapshot(), (error) => error.code === 'reauth-required')
})

test('isTerminalRefreshCode recognizes permanent failures', () => {
  assert.equal(isTerminalRefreshCode('invalid_grant'), true)
  assert.equal(isTerminalRefreshCode('refresh_token_reused'), true)
  assert.equal(isTerminalRefreshCode('revoked'), true)
  assert.equal(isTerminalRefreshCode('upstream'), false)
})
