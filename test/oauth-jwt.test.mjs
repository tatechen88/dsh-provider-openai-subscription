import test from 'node:test'
import assert from 'node:assert/strict'
import { decodeJwtPayload, extractAccountId, extractEmail } from '../src/oauth/jwt.js'

function makeJwt(payload) {
  const header = Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url')
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
  return `${header}.${body}.sig`
}

test('decodeJwtPayload decodes payload', () => {
  const payload = decodeJwtPayload(makeJwt({ email: 'a@b.c', chatgpt_account_id: 'acct_1' }))
  assert.equal(payload.email, 'a@b.c')
  assert.equal(payload.chatgpt_account_id, 'acct_1')
})

test('decodeJwtPayload returns undefined for malformed input', () => {
  assert.equal(decodeJwtPayload(''), undefined)
  assert.equal(decodeJwtPayload('abc'), undefined)
  assert.equal(decodeJwtPayload('a.b.c'), undefined)
  assert.equal(decodeJwtPayload('x.not-json.sig'), undefined)
})

test('extractAccountId prefers direct claim then namespace then organization', () => {
  assert.equal(extractAccountId(makeJwt({ chatgpt_account_id: 'direct' })), 'direct')
  assert.equal(extractAccountId(makeJwt({ 'https://api.openai.com/auth': { chatgpt_account_id: 'ns' } })), 'ns')
  assert.equal(extractAccountId(makeJwt({ organizations: [{ id: 'org-1' }] })), 'org-1')
  assert.equal(extractAccountId(makeJwt({})), undefined)
})

test('extractEmail lowercases email', () => {
  assert.equal(extractEmail(makeJwt({ email: 'User@Example.COM' })), 'user@example.com')
  assert.equal(extractEmail(undefined, makeJwt({ email: 'A@B.c' })), 'a@b.c')
})
