import test from 'node:test'
import assert from 'node:assert/strict'
import { generatePKCE, generateVerifier, generateChallenge } from '../src/oauth/pkce.js'
import { generateState } from '../src/oauth/state.js'

test('PKCE verifier is high entropy and challenge is S256 base64url', () => {
  const { verifier, challenge } = generatePKCE()
  assert.ok(verifier.length >= 100)
  assert.ok(/^[A-Za-z0-9_-]+$/.test(verifier))
  assert.equal(challenge, generateChallenge(verifier))
  assert.notEqual(challenge, verifier)
})

test('PKCE pairs are unique', () => {
  const a = generatePKCE()
  const b = generatePKCE()
  assert.notEqual(a.verifier, b.verifier)
  assert.notEqual(a.challenge, b.challenge)
})

test('state tokens are unique hex strings', () => {
  const a = generateState()
  const b = generateState()
  assert.equal(a.length, 32)
  assert.match(a, /^[0-9a-f]{32}$/)
  assert.notEqual(a, b)
})
