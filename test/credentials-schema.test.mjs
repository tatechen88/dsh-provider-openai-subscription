import test from 'node:test'
import assert from 'node:assert/strict'
import { parseGrant, createGrant, redactGrant, maskEmail, maskAccountId, CredentialSchemaError } from '../src/credentials/schema.js'

const validGrant = {
  schemaVersion: 1,
  type: 'oauth',
  access: 'at-1',
  refresh: 'rt-1',
  expires: 1786000000000,
  accountId: 'acct_1234567890',
  email: 'User@Example.com',
  obtainedAt: 1780000000000,
}

test('parseGrant accepts a complete grant and freezes it', () => {
  const grant = parseGrant(validGrant)
  assert.equal(grant.access, 'at-1')
  assert.equal(Object.isFrozen(grant), true)
})

test('parseGrant rejects malformed payloads', () => {
  const cases = [
    [null, 'malformed-grant'],
    ['x', 'malformed-grant'],
    [{ ...validGrant, schemaVersion: 2 }, 'unsupported-schema'],
    [{ ...validGrant, type: 'api_key' }, 'unexpected-type'],
    [{ ...validGrant, access: '' }, 'missing-access-token'],
    [{ ...validGrant, refresh: '' }, 'missing-refresh-token'],
    [{ ...validGrant, expires: NaN }, 'missing-expiry'],
    [{ ...validGrant, expires: 0 }, 'missing-expiry'],
    [{ ...validGrant, accountId: '' }, 'missing-account-id'],
    [{ ...validGrant, email: '' }, 'malformed-email'],
    [{ ...validGrant, obtainedAt: NaN }, 'malformed-obtained-at'],
    [{ ...validGrant, needsReauth: 'yes' }, 'malformed-reauth-flag'],
  ]
  for (const [payload, code] of cases) {
    assert.throws(() => parseGrant(payload), (error) => error instanceof CredentialSchemaError && error.code === code)
  }
})

test('createGrant builds a grant with obtainedAt', () => {
  const before = Date.now()
  const grant = createGrant({ access: 'a', refresh: 'r', expires: 123, accountId: 'acct' })
  const after = Date.now()
  assert.equal(grant.schemaVersion, 1)
  assert.equal(grant.access, 'a')
  assert.ok(grant.obtainedAt >= before && grant.obtainedAt <= after)
})

test('redactGrant never contains tokens', () => {
  const redacted = redactGrant(parseGrant(validGrant))
  assert.equal(redacted.configured, true)
  assert.equal(redacted.accountId, maskAccountId(validGrant.accountId))
  assert.equal(redacted.email, maskEmail(validGrant.email))
  assert.ok(!JSON.stringify(redacted).includes('at-1'))
  assert.ok(!JSON.stringify(redacted).includes('rt-1'))
})

test('maskAccountId shortens long ids and hides short ids', () => {
  assert.equal(maskAccountId('acct_1234567890'), 'acct...7890')
  assert.equal(maskAccountId('short'), '***')
})

test('maskEmail keeps domain', () => {
  assert.equal(maskEmail('user@example.com'), 'us***@example.com')
})
