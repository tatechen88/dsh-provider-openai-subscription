import test from 'node:test'
import assert from 'node:assert/strict'
import { ResponsesEventTranslator, usageFromResponse } from '../src/provider/event-translator.js'

test('translates text delta and completed', () => {
  const t = new ResponsesEventTranslator()
  const chunks = [
    ...t.push({ type: 'response.output_text.delta', output_index: 0, delta: 'Hel' }),
    ...t.push({ type: 'response.output_text.delta', output_index: 0, delta: 'lo' }),
    ...t.push({ type: 'response.output_text.done', output_index: 0, text: 'Hello' }),
    ...t.push({ type: 'response.completed' }),
  ]
  assert.deepEqual(chunks[0], { type: 'text-delta', index: 0, text: 'Hel' })
  assert.equal(chunks[2].type, 'block-end')
  assert.deepEqual(chunks[3].reason, { kind: 'stop' })
})

test('translates function call deltas', () => {
  const t = new ResponsesEventTranslator()
  const chunks = [
    ...t.push({ type: 'response.output_item.added', item: { id: 'fc_1', type: 'function_call', call_id: 'call_1', name: 'bash' } }),
    ...t.push({ type: 'response.function_call_arguments.delta', item_id: 'fc_1', call_id: 'call_1', delta: '{"co' }),
    ...t.push({ type: 'response.function_call_arguments.done', item_id: 'fc_1', call_id: 'call_1', name: 'bash', arguments: '{"cmd":"ls"}' }),
    ...t.push({ type: 'response.completed' }),
  ]
  assert.equal(chunks[0].type, 'block-start')
  assert.equal(chunks[1].type, 'tool-call-delta')
  assert.equal(chunks[1].name, 'bash')
  assert.equal(chunks[2].type, 'tool-call-delta')
  assert.equal(chunks[2].argumentsDelta, '{"co')
  assert.equal(chunks[3].type, 'block-end')
  assert.equal(chunks[3].block.arguments, '{"cmd":"ls"}')
})

test('end returns STREAM_CLOSED when not completed', () => {
  const t = new ResponsesEventTranslator()
  const chunks = t.end()
  assert.equal(chunks.length, 1)
  assert.equal(chunks[0].reason.kind, 'error')
  assert.equal(chunks[0].reason.failure.code, 'STREAM_CLOSED')
})

test('end is empty after completed', () => {
  const t = new ResponsesEventTranslator()
  t.push({ type: 'response.completed' })
  assert.deepEqual(t.end(), [])
})

test('error event translates to error finish', () => {
  const t = new ResponsesEventTranslator()
  const chunks = t.push({ type: 'error', message: 'boom' })
  assert.equal(chunks[0].reason.kind, 'error')
  assert.equal(chunks[0].reason.failure.message, 'boom')
})

test('a terminal event is finalized once, whatever ended the stream', () => {
  const errored = new ResponsesEventTranslator()
  assert.equal(errored.push({ type: 'response.failed', message: 'upstream exploded' })[0].reason.failure.message, 'upstream exploded')
  assert.deepEqual(errored.end(), [], 'the failure finish is already terminal')

  const streamError = new ResponsesEventTranslator()
  assert.equal(streamError.push({ type: 'error', message: 'boom' })[0].reason.failure.code, 'provider-error')
  assert.deepEqual(streamError.end(), [], 'a provider error is already terminal')

  const truncated = new ResponsesEventTranslator()
  truncated.push({ type: 'response.completed' })
  assert.deepEqual(truncated.end(), [], 'a completed response is already terminal')
})

test('a stream that ends without any terminal event is closed once', () => {
  const t = new ResponsesEventTranslator()
  t.push({ type: 'response.output_text.delta', output_index: 0, delta: 'half' })
  assert.equal(t.end()[0].reason.failure.code, 'STREAM_CLOSED')
  assert.deepEqual(t.end(), [], 'the closed stream cannot finish twice')
})

test('usage splits OpenAI cache reads out of the disjoint input count', () => {
  const usage = usageFromResponse({
    usage: {
      input_tokens: 12_000,
      output_tokens: 800,
      total_tokens: 12_800,
      input_tokens_details: { cached_tokens: 9_000 },
      output_tokens_details: { reasoning_tokens: 300 },
    },
  })
  assert.deepEqual(usage, {
    inputTokens: 3_000,
    outputTokens: 800,
    totalTokens: 12_800,
    cacheReadTokens: 9_000,
    reasoningTokens: 300,
  })
})

test('usage keeps an explicit zero cache read but omits an unreported one', () => {
  assert.deepEqual(
    usageFromResponse({ usage: { input_tokens: 100, output_tokens: 10, input_tokens_details: { cached_tokens: 0 } } }),
    { inputTokens: 100, outputTokens: 10, totalTokens: 110, cacheReadTokens: 0 },
    'a reported zero is a fact and must survive',
  )
  assert.deepEqual(
    usageFromResponse({ usage: { input_tokens: 100, output_tokens: 10 } }),
    { inputTokens: 100, outputTokens: 10, totalTokens: 110 },
    'an unreported cache read must not be invented as zero',
  )
})

test('usage drops details that cannot be true instead of going negative', () => {
  assert.deepEqual(
    usageFromResponse({ usage: { input_tokens: 100, output_tokens: 10, input_tokens_details: { cached_tokens: 500 } } }),
    { inputTokens: 100, outputTokens: 10, totalTokens: 110 },
    'a cache read larger than the prompt is not a cache hit',
  )
  assert.deepEqual(
    usageFromResponse({ usage: { input_tokens: 100, output_tokens: 10, output_tokens_details: { reasoning_tokens: 40 } } }),
    { inputTokens: 100, outputTokens: 10, totalTokens: 110 },
    'reasoning tokens cannot exceed the output they belong to',
  )
  assert.deepEqual(
    usageFromResponse({ usage: { input_tokens: 100.5, output_tokens: 10 } }),
    undefined,
    'a non-integer aggregate is not a count',
  )
  assert.equal(usageFromResponse({ usage: { output_tokens: 10 } }), undefined)
  assert.equal(usageFromResponse({}), undefined)
  assert.equal(usageFromResponse(null), undefined)
  assert.equal(usageFromResponse({ usage: null }), undefined)
})

test('a completed response emits usage before the finish and only once', () => {
  const t = new ResponsesEventTranslator()
  const usageEvent = {
    type: 'response.completed',
    response: {
      usage: {
        input_tokens: 1_000,
        output_tokens: 50,
        input_tokens_details: { cached_tokens: 800 },
      },
    },
  }
  const chunks = t.push(usageEvent)
  assert.equal(chunks[0].type, 'usage', 'usage must precede the terminal finish')
  assert.deepEqual(chunks[0].usage, { inputTokens: 200, outputTokens: 50, totalTokens: 1_050, cacheReadTokens: 800 })
  assert.equal(chunks[1].type, 'finish')
  assert.deepEqual(chunks[1].reason, { kind: 'stop' })
  assert.deepEqual(t.push(usageEvent), [{ type: 'finish', reason: { kind: 'stop' } }], 'a repeated terminal event adds no second usage')
})

test('usage rides the event itself when a gateway flattens the response', () => {
  const t = new ResponsesEventTranslator()
  const chunks = t.push({ type: 'response.completed', usage: { input_tokens: 40, output_tokens: 2, input_tokens_details: { cached_tokens: 30 } } })
  assert.deepEqual(chunks[0].usage, { inputTokens: 10, outputTokens: 2, totalTokens: 42, cacheReadTokens: 30 })
})

test('an incomplete response still reports the tokens it billed', () => {
  const t = new ResponsesEventTranslator()
  const chunks = t.push({
    type: 'response.incomplete',
    response: { usage: { input_tokens: 500, output_tokens: 20, input_tokens_details: { cached_tokens: 100 } } },
  })
  assert.equal(chunks[0].type, 'usage')
  assert.deepEqual(chunks[0].usage, { inputTokens: 400, outputTokens: 20, totalTokens: 520, cacheReadTokens: 100 })
  assert.equal(chunks[1].type, 'finish')
  assert.equal(chunks[1].reason.kind, 'error')
})

test('a completed response without usage keeps the plain finish chunk', () => {
  const t = new ResponsesEventTranslator()
  assert.deepEqual(t.push({ type: 'response.completed', response: {} }), [{ type: 'finish', reason: { kind: 'stop' } }])
})
