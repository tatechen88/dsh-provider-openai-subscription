import test from 'node:test'
import assert from 'node:assert/strict'
import { OpenAISubscriptionAdapter, MODEL_CATALOG_TTL_MS, OPENAI_RESPONSES_URL } from '../src/provider/adapter.js'

function sseResponse(...events) {
  const body = events.map((data) => `data: ${JSON.stringify(data)}\n\n`).join('')
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(body))
      controller.close()
    },
  })
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

test('stream translates SSE into chunks', async () => {
  const adapter = new OpenAISubscriptionAdapter({
    getAccess: async () => ({ accessToken: 'at', accountId: 'acct_1' }),
    fetchImpl: async (url, init) => {
      assert.equal(url, OPENAI_RESPONSES_URL)
      assert.equal(init.headers.authorization, 'Bearer at')
      assert.equal(init.headers['chatgpt-account-id'], 'acct_1')
      const body = JSON.parse(init.body)
      assert.deepEqual(body.reasoning, { effort: 'high' })
      return sseResponse(
        { type: 'response.output_text.delta', output_index: 0, delta: 'Hi' },
        { type: 'response.output_text.done', output_index: 0, text: 'Hi' },
        { type: 'response.completed' },
      )
    },
    reasoningEffort: 'high',
  })
  const chunks = []
  for await (const chunk of adapter.stream({ provider: 'openai-subscription', model: 'gpt-5', messages: [] })) {
    chunks.push(chunk)
  }
  assert.equal(chunks[0].type, 'text-delta')
  assert.equal(chunks[0].text, 'Hi')
  assert.equal(chunks.at(-1).type, 'finish')
  assert.equal(chunks.at(-1).reason.kind, 'stop')
})

test('stream surfaces the terminal usage reading before the finish', async () => {
  const adapter = new OpenAISubscriptionAdapter({
    getAccess: async () => ({ accessToken: 'at', accountId: 'acct_1' }),
    fetchImpl: async () => sseResponse(
      { type: 'response.output_text.delta', output_index: 0, delta: 'Hi' },
      { type: 'response.output_text.done', output_index: 0, text: 'Hi' },
      {
        type: 'response.completed',
        response: {
          usage: {
            input_tokens: 12_000,
            output_tokens: 800,
            total_tokens: 12_800,
            input_tokens_details: { cached_tokens: 9_000 },
          },
        },
      },
    ),
  })
  const chunks = []
  for await (const chunk of adapter.stream({ provider: 'openai-subscription', model: 'gpt-5', messages: [] })) {
    chunks.push(chunk)
  }
  const usageIndex = chunks.findIndex((chunk) => chunk.type === 'usage')
  assert.notEqual(usageIndex, -1, 'the adapter must surface OpenAI usage')
  assert.deepEqual(chunks[usageIndex].usage, {
    inputTokens: 3_000,
    outputTokens: 800,
    totalTokens: 12_800,
    cacheReadTokens: 9_000,
  })
  assert.equal(chunks.at(-1).type, 'finish', 'usage travels before the terminal finish')
  assert.ok(usageIndex < chunks.length - 1)
})

test('stream maps 401 to unauthorized', async () => {
  const adapter = new OpenAISubscriptionAdapter({
    getAccess: async () => ({ accessToken: 'at', accountId: 'a' }),
    fetchImpl: async () => new Response('{}', { status: 401 }),
  })
  await assert.rejects(
    (async () => {
      for await (const _chunk of adapter.stream({ provider: 'p', model: 'm', messages: [] })) { /* collect */ }
    })(),
    (error) => error instanceof Error && error.code === 'unauthorized',
  )
})

test('listModels delegates to model client', async () => {
  const adapter = new OpenAISubscriptionAdapter({
    getAccess: async () => ({ accessToken: 'at', accountId: 'a' }),
    fetchImpl: async (url) => {
      assert.equal(url, 'https://chatgpt.com/backend-api/codex/models?client_version=1.0.0')
      return new Response(JSON.stringify([{ id: 'gpt-5', name: 'GPT-5' }]), { status: 200 })
    },
  })
  const models = await adapter.listModels('openai-subscription')
  assert.deepEqual(models, [{ provider: 'openai-subscription', id: 'gpt-5', name: 'GPT-5' }])
})

test('the catalogue expires on its own, so a shipped model appears without a restart', async () => {
  let now = 1_000
  let calls = 0
  const adapter = new OpenAISubscriptionAdapter({
    getAccess: async () => ({ accessToken: 'at', accountId: 'a' }),
    now: () => now,
    fetchImpl: async () => {
      calls += 1
      return new Response(JSON.stringify([{ id: `gpt-${calls}`, name: `GPT-${calls}` }]), { status: 200 })
    },
  })

  assert.deepEqual((await adapter.listModels('p')).map((model) => model.id), ['gpt-1'])
  assert.deepEqual((await adapter.listModels('p')).map((model) => model.id), ['gpt-1'], 'the list is reused while it is fresh')
  assert.equal(calls, 1)

  now += MODEL_CATALOG_TTL_MS
  assert.deepEqual((await adapter.listModels('p')).map((model) => model.id), ['gpt-2'], 'and read again once it expires')

  adapter.invalidateCatalog()
  assert.deepEqual((await adapter.listModels('p')).map((model) => model.id), ['gpt-3'], 'a refresh drops the cache instead of returning it')
})

test('resolveModel exposes reasoning efforts, default effort, and context', async () => {
  const adapter = new OpenAISubscriptionAdapter({
    getAccess: async () => ({ accessToken: 'at', accountId: 'a' }),
    fetchImpl: async () => new Response(JSON.stringify({ models: [
      {
        slug: 'gpt-6-astra',
        display_name: 'GPT-6-Astra',
        context_window: 272000,
        default_reasoning_level: 'low',
        supported_reasoning_levels: [
          { effort: 'low', description: 'Fast' },
          { effort: 'max', description: 'Deepest' },
        ],
      },
    ] }), { status: 200 }),
  })
  const info = await adapter.resolveModel('openai-subscription', 'gpt-6-astra')
  assert.equal(info.name, 'GPT-6-Astra')
  assert.deepEqual(info.inputModalities, ['text'])
  assert.deepEqual(info.context, { contextWindow: 272000 })
  assert.deepEqual(info.reasoning.efforts.map((effort) => effort.id), ['low', 'max'])
  assert.equal(info.reasoning.defaultEffort, 'low')
})

test('resolveModel falls back for an unknown model id', async () => {
  const adapter = new OpenAISubscriptionAdapter({
    getAccess: async () => ({ accessToken: 'at', accountId: 'a' }),
    fetchImpl: async () => new Response(JSON.stringify({ models: [] }), { status: 200 }),
  })
  const info = await adapter.resolveModel('openai-subscription', 'unknown')
  assert.deepEqual(info, { provider: 'openai-subscription', id: 'unknown', name: 'unknown' })
})
