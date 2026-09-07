import test from 'node:test'
import assert from 'node:assert/strict'
import {
  fetchModels, normalizeModelCatalog, normalizeModels, ModelClientError,
  OPENAI_MODELS_URL, OPENAI_MODELS_CLIENT_VERSION, modelsCatalogUrl,
} from '../src/models/client.js'

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

test('normalizeModels accepts the upstream object form with slug/display_name', () => {
  const models = normalizeModels({ models: [
    { slug: 'gpt-6-astra', display_name: 'GPT-6-Astra' },
    { slug: 'gpt-5.4-mini' },
    { display_name: 'No slug' },
    { slug: 'gpt-6-astra', display_name: 'Duplicate' },
  ] })
  assert.deepEqual(models, [
    { id: 'gpt-6-astra', name: 'GPT-6-Astra' },
    { id: 'gpt-5.4-mini' },
  ])
})

test('fetchModels requests the client_version query and normalizes the object form', async () => {
  let seenUrl
  let seenHeaders
  const models = await fetchModels({
    getAccess: async () => ({ accessToken: 'at', accountId: 'acct_1' }),
    fetchImpl: async (url, init) => {
      seenUrl = url
      seenHeaders = init.headers
      return jsonResponse(200, { models: [{ slug: 'gpt-5', display_name: 'GPT-5' }] })
    },
  })
  assert.equal(seenUrl, modelsCatalogUrl())
  assert.equal(seenUrl, `${OPENAI_MODELS_URL}?client_version=${OPENAI_MODELS_CLIENT_VERSION}`)
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

test('fetchModels maps malformed JSON to malformed-models', async () => {
  await assert.rejects(
    fetchModels({
      getAccess: async () => ({ accessToken: 'at', accountId: 'a' }),
      fetchImpl: async () => jsonResponse(200, { models: 'nope' }),
    }),
    (error) => error.code === 'malformed-models',
  )
})

test('normalizeModelCatalog exposes reasoning efforts and context', () => {
  const catalog = normalizeModelCatalog({ models: [
    {
      slug: 'gpt-6-astra',
      display_name: 'GPT-6-Astra',
      context_window: 272000,
      default_reasoning_level: 'low',
      supported_reasoning_levels: [
        { effort: 'low', description: 'Fast responses' },
        { effort: 'max', description: 'Maximum depth' },
      ],
    },
    { slug: 'gpt-5.4-mini', supported_reasoning_levels: [] },
  ] })
  assert.equal(catalog.length, 2)
  assert.equal(catalog[0].id, 'gpt-6-astra')
  assert.equal(catalog[0].contextWindow, 272000)
  assert.deepEqual(catalog[0].reasoning.efforts.map((effort) => effort.id), ['low', 'max'])
  assert.equal(catalog[0].reasoning.defaultEffort, 'low')
  assert.equal(catalog[0].reasoning.efforts[0].name, 'Low')
  assert.equal(catalog[1].reasoning, undefined, 'models without levels omit reasoning')
})
