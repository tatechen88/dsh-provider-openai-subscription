import test from 'node:test'
import assert from 'node:assert/strict'
import {
  exchangeAuthorizationCode, refreshAccessToken, parseTokenResponse, OAuthTokenError, OPENAI_TOKEN_URL,
} from '../src/oauth/token-client.js'

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

test('exchangeAuthorizationCode posts form body and parses tokens', async () => {
  let seenUrl
  let seenBody
  const result = await exchangeAuthorizationCode({
    clientId: 'cid',
    code: 'code',
    redirectUri: 'http://localhost:1455/auth/callback',
    codeVerifier: 'verifier',
    fetchImpl: async (url, init) => {
      seenUrl = url
      seenBody = new URLSearchParams(init.body)
      return jsonResponse(200, { access_token: 'at', refresh_token: 'rt', expires_in: 3600, id_token: 'id' })
    },
  })
  assert.equal(seenUrl, OPENAI_TOKEN_URL)
  assert.equal(seenBody.get('grant_type'), 'authorization_code')
  assert.equal(seenBody.get('client_id'), 'cid')
  assert.equal(seenBody.get('code'), 'code')
  assert.equal(seenBody.get('code_verifier'), 'verifier')
  assert.equal(result.access, 'at')
  assert.equal(result.refresh, 'rt')
  assert.equal(result.idToken, 'id')
  assert.ok(result.expires > Date.now())
})

test('refreshAccessToken sends refresh_token grant', async () => {
  let seenBody
  const result = await refreshAccessToken({
    clientId: 'cid',
    refreshToken: 'rt',
    fetchImpl: async (_url, init) => {
      seenBody = new URLSearchParams(init.body)
      return jsonResponse(200, { access_token: 'at2', refresh_token: 'rt2', expires_in: 1800 })
    },
  })
  assert.equal(seenBody.get('grant_type'), 'refresh_token')
  assert.equal(seenBody.get('refresh_token'), 'rt')
  assert.equal(result.access, 'at2')
  assert.equal(result.refresh, 'rt2')
})

test('parseTokenResponse rejects missing access token', () => {
  assert.throws(() => parseTokenResponse({}), (error) => error instanceof OAuthTokenError && error.code === 'missing-access-token')
})

test('parseTokenResponse rejects malformed refresh token', () => {
  assert.throws(() => parseTokenResponse({ access_token: 'a', refresh_token: '' }), OAuthTokenError)
})

test('token endpoint HTTP error surfaces a stable code', async () => {
  await assert.rejects(
    exchangeAuthorizationCode({
      clientId: 'cid', code: 'c', redirectUri: 'r', codeVerifier: 'v',
      fetchImpl: async () => jsonResponse(400, { error: 'invalid_grant', error_description: 'bad' }),
    }),
    (error) => error instanceof OAuthTokenError && error.code === 'token-exchange-failed' && /invalid_grant/.test(error.message),
  )
})

test('token endpoint non-JSON surfaces invalid-json', async () => {
  await assert.rejects(
    exchangeAuthorizationCode({
      clientId: 'cid', code: 'c', redirectUri: 'r', codeVerifier: 'v',
      fetchImpl: async () => new Response('oops', { status: 200 }),
    }),
    (error) => error instanceof OAuthTokenError && error.code === 'invalid-json',
  )
})

test('token endpoint network failure surfaces network code', async () => {
  await assert.rejects(
    exchangeAuthorizationCode({
      clientId: 'cid', code: 'c', redirectUri: 'r', codeVerifier: 'v',
      fetchImpl: async () => { throw new Error('socket') },
    }),
    (error) => error instanceof OAuthTokenError && error.code === 'network',
  )
})
