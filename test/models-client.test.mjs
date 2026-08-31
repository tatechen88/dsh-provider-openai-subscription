import test from 'node:test'
import assert from 'node:assert/strict'
import { fetchModels, normalizeModels, ModelClientError, OPENAI_MODELS_URL } from '../src/models/client.js'

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

test('normalizeModels keeps unique valid models and drops junk', () => {
  const models = normalizeModels([
    { id: 'gpt-5', name: 'GPT-5' },
    { id: 'gpt-5', name: 'Duplicate' },
    { id: '', name: 'Empty' },
    null,
    { name: 'No id' },
  ])
  assert.deepEqual(models, [{ id: 'gpt-5', name: 'GPT-5' }])
})

test('fetchModels sends auth headers and normalizes response', async () => {
  let seenHeaders
  const models = await fetchModels({
    getAccess: async () => ({ accessToken: 'at', accountId: 'acct_1' }),
    fetchImpl: async (url, init) => {
      assert.equal(url, OPENAI_MODELS_URL)
      seenHeaders = init.headers
      return jsonResponse(200, [{ id: 'gpt-5', name: 'GPT-5' }])
    },
  })
  assert.equal(seenHeaders.authorization, 'Bearer at')
  assert.equal(seenHeaders['chatgpt-account-id'], 'acct_1')
  assert.deepEqual(models, [{ id: 'gpt-5', name: 'GPT-5' }])
})

test('fetchModels maps not signed in', async () => {
  await assert.rejects(
    fetchModels({
      getAccess: async () => { const error = new Error('no'); error.code = 'not-signed-in'; throw error },
      fetchImpl: async () => { throw new Error('unused') },
    }),
    (error) => error instanceof ModelClientError && error.code === 'not-signed-in',
  )
})

test('fetchModels maps 401', async () => {
  await assert.rejects(
    fetchModels({
      getAccess: async () => ({ accessToken: 'at', accountId: 'a' }),
      fetchImpl: async () => jsonResponse(401, {}),
    }),
    (error) => error.code === 'unauthorized',
  )
})

test('fetchModels maps non-array JSON to malformed-models', async () => {
  await assert.rejects(
    fetchModels({
      getAccess: async () => ({ accessToken: 'at', accountId: 'a' }),
      fetchImpl: async () => jsonResponse(200, { models: [] }),
    }),
    (error) => error.code === 'malformed-models',
  )
})
