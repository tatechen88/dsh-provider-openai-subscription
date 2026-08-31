import test from 'node:test'
import assert from 'node:assert/strict'
import { CredentialRepository, CredentialRepositoryError } from '../src/credentials/repository.js'
import { parseGrant, CredentialSchemaError } from '../src/credentials/schema.js'
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

const grant = parseGrant({
  schemaVersion: 1,
  type: 'oauth',
  access: 'at',
  refresh: 'rt',
  expires: 1786000000000,
  accountId: 'acct_123',
})

test('read returns undefined when no record exists', async () => {
  const repo = new CredentialRepository(fakeProvider())
  assert.equal(await repo.read(), undefined)
})

test('read validates and returns stored grant', async () => {
  const repo = new CredentialRepository(fakeProvider({ kind: 'grant', payload: grant }))
  const read = await repo.read()
  assert.equal(read.access, 'at')
})

test('read rejects unexpected record kind', async () => {
  const repo = new CredentialRepository(fakeProvider({ kind: 'api-key', key: 'x' }))
  await assert.rejects(repo.read(), CredentialSchemaError)
})

test('write persists a grant', async () => {
  const provider = fakeProvider()
  const repo = new CredentialRepository(provider)
  const saved = await repo.write(grant)
  assert.equal(saved.access, 'at')
  const stored = await provider.readRecord(CREDENTIAL_KEY)
  assert.equal(stored.kind, 'grant')
  assert.equal(stored.payload.accountId, 'acct_123')
})

test('mutate replaces only when the new grant is returned', async () => {
  const provider = fakeProvider({ kind: 'grant', payload: grant })
  const repo = new CredentialRepository(provider)
  await repo.mutate(async (current) => {
    assert.equal(current.refresh, 'rt')
    return { ...current, access: 'at2' }
  })
  assert.equal((await repo.read()).access, 'at2')
  await repo.mutate(async () => undefined)
  assert.equal(await repo.read(), undefined)
})

test('delete removes the record', async () => {
  const repo = new CredentialRepository(fakeProvider({ kind: 'grant', payload: grant }))
  await repo.delete()
  assert.equal(await repo.read(), undefined)
})

test('status is redacted and reflects configuration', async () => {
  const repo = new CredentialRepository(fakeProvider({ kind: 'grant', payload: grant }))
  const status = await repo.status()
  assert.equal(status.configured, true)
  assert.equal(status.kind, 'grant')
  assert.equal(status.writable, true)
  assert.equal(status.grant.configured, true)
  assert.ok(!JSON.stringify(status).includes('at'))
  assert.ok(!JSON.stringify(status).includes('rt'))
})

test('constructor requires a credential provider', () => {
  assert.throws(() => new CredentialRepository({}), CredentialRepositoryError)
})
