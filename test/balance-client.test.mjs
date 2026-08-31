import test from 'node:test'
import assert from 'node:assert/strict'
import { fetchBalance, BalanceClientError, OPENAI_USAGE_URL } from '../src/balance/client.js'

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

test('fetchBalance sends token and account headers and normalizes response', async () => {
  let seenHeaders
  const snapshot = await fetchBalance({
    getAccess: async () => ({ accessToken: 'at', accountId: 'acct_1' }),
    fetchImpl: async (url, init) => {
      assert.equal(url, OPENAI_USAGE_URL)
      seenHeaders = init.headers
      return jsonResponse(200, { plan_type: 'pro', rate_limit: { primary_window: { used_percent: 10 } } })
    },
  })
  assert.equal(seenHeaders.authorization, 'Bearer at')
  assert.equal(seenHeaders['chatgpt-account-id'], 'acct_1')
  assert.equal(snapshot.status, 'ready')
  assert.equal(snapshot.windows[0].usedPercent, 10)
})

test('fetchBalance maps not signed in', async () => {
  await assert.rejects(
    fetchBalance({
      getAccess: async () => { const error = new Error('no'); error.code = 'not-signed-in'; throw error },
      fetchImpl: async () => { throw new Error('unused') },
    }),
    (error) => error instanceof BalanceClientError && error.code === 'not-signed-in',
  )
})

test('fetchBalance maps 401 to unauthorized', async () => {
  await assert.rejects(
    fetchBalance({
      getAccess: async () => ({ accessToken: 'at', accountId: 'a' }),
      fetchImpl: async () => jsonResponse(401, {}),
    }),
    (error) => error instanceof BalanceClientError && error.code === 'unauthorized',
  )
})

test('fetchBalance maps 429 to rate-limited', async () => {
  await assert.rejects(
    fetchBalance({
      getAccess: async () => ({ accessToken: 'at', accountId: 'a' }),
      fetchImpl: async () => jsonResponse(429, {}),
    }),
    (error) => error.code === 'rate-limited',
  )
})

test('fetchBalance maps non-JSON to invalid-json', async () => {
  await assert.rejects(
    fetchBalance({
      getAccess: async () => ({ accessToken: 'at', accountId: 'a' }),
      fetchImpl: async () => new Response('oops', { status: 200 }),
    }),
    (error) => error.code === 'invalid-json',
  )
})
