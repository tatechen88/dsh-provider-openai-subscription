import test from 'node:test'
import assert from 'node:assert/strict'
import { OpenAISubscriptionAdapter, OPENAI_RESPONSES_URL } from '../src/provider/adapter.js'

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
      assert.equal(url, 'https://chatgpt.com/backend-api/codex/models')
      return new Response(JSON.stringify([{ id: 'gpt-5', name: 'GPT-5' }]), { status: 200 })
    },
  })
  const models = await adapter.listModels('openai-subscription')
  assert.deepEqual(models, [{ provider: 'openai-subscription', id: 'gpt-5', name: 'GPT-5' }])
})
