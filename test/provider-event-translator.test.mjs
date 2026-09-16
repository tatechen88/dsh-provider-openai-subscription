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
  assert.deepEqual(chunks[0], { type: 'block-start', index: 0, blockType: 'text' })
  assert.deepEqual(chunks[1], { type: 'text-delta', index: 0, text: 'Hel' })
  assert.equal(chunks[3].type, 'block-end')
  assert.deepEqual(chunks[3].block, { type: 'text', text: 'Hello' })
  assert.deepEqual(chunks[4].reason, { kind: 'stop' })
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
  assert.deepEqual(t.push(usageEvent), [], 'a chunk after the terminal finish would break the stream grammar')
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

test('a done event without the item id still reaches its own run', () => {
  // The wire normally repeats `item_id`, but a gateway may drop it and keep only
  // `output_index`. Opening a second, empty text block would then be legal but
  // wrong: the message would carry an extra empty block.
  const t = new ResponsesEventTranslator()
  const chunks = [
    ...t.push({ type: 'response.output_text.delta', item_id: 'msg_1', output_index: 0, delta: 'Hi' }),
    ...t.push({ type: 'response.output_text.done', output_index: 0, text: 'Hi' }),
    ...t.push({ type: 'response.completed' }),
  ]
  const starts = chunks.filter((chunk) => chunk.type === 'block-start')
  const ends = chunks.filter((chunk) => chunk.type === 'block-end')
  assert.equal(starts.length, 1, 'the run opens exactly one block')
  assert.equal(ends.length, 1, 'and closes exactly that one')
  assert.equal(ends[0].index, starts[0].index)
  assert.deepEqual(ends[0].block, { type: 'text', text: 'Hi' })
  assertStreamGrammar(chunks)
})

test('a tool call whose later events drop the item id keeps one block', () => {
  const t = new ResponsesEventTranslator()
  const chunks = [
    ...t.push({ type: 'response.output_item.added', output_index: 0, item: { id: 'fc_1', type: 'function_call', call_id: 'call_1', name: 'bash' } }),
    ...t.push({ type: 'response.function_call_arguments.delta', output_index: 0, call_id: 'call_1', delta: '{"c"' }),
    ...t.push({ type: 'response.function_call_arguments.done', output_index: 0, call_id: 'call_1', name: 'bash', arguments: '{"c":1}' }),
    ...t.push({ type: 'response.completed' }),
  ]
  // `output_index: 0` on the item reserves index 0, so an event with no item id
  // resolves through the alias to the same block.
  const starts = chunks.filter((chunk) => chunk.type === 'block-start')
  assert.equal(starts.length, 1, 'one item, one block')
  assertStreamGrammar(chunks)
})

test('a completed response without usage keeps the plain finish chunk', () => {
  const t = new ResponsesEventTranslator()
  assert.deepEqual(t.push({ type: 'response.completed', response: {} }), [{ type: 'finish', reason: { kind: 'stop' } }])
})

/**
 * Reproduce the DSH 0.1.6 `llm/stream` grammar check
 * (packages/llm/llm/src/invariant.ts) so a translator change that would be
 * rejected by the running harness fails here instead.
 * @param {Array<Record<string, unknown>>} chunks
 */
function assertStreamGrammar(chunks) {
  const open = new Map()
  let usageSeen = false
  let finished = false
  for (const chunk of chunks) {
    assert.equal(finished, false, `chunk ${chunk.type} arrived after a terminal finish`)
    switch (chunk.type) {
      case 'block-start':
        assert.equal(open.has(chunk.index), false, `block-start repeated index ${chunk.index}`)
        open.set(chunk.index, chunk.blockType)
        break
      case 'text-delta':
        assert.equal(open.get(chunk.index), 'text', `text-delta at ${chunk.index} needs an open text block`)
        break
      case 'reasoning-delta':
        assert.equal(open.get(chunk.index), 'reasoning', `reasoning-delta at ${chunk.index} needs an open reasoning block`)
        break
      case 'tool-call-delta':
        assert.equal(open.get(chunk.index), 'tool-call', `tool-call-delta at ${chunk.index} needs an open tool-call block`)
        break
      case 'block-end':
        assert.equal(open.get(chunk.index), chunk.block.type, `block-end at ${chunk.index} must close the open block`)
        open.delete(chunk.index)
        break
      case 'usage':
        assert.equal(usageSeen, false, 'usage may be emitted once')
        usageSeen = true
        break
      case 'finish':
        if (chunk.reason.kind !== 'error' && chunk.reason.kind !== 'aborted') {
          assert.equal(open.size, 0, 'a successful finish must not leave an open block')
        }
        finished = true
        break
      default:
        assert.fail(`unknown chunk type ${chunk.type}`)
    }
  }
  assert.equal(finished, true, 'the stream must end with a terminal finish')
}

test('a text run opens its own block before any delta', () => {
  const t = new ResponsesEventTranslator()
  const chunks = [
    ...t.push({ type: 'response.output_text.delta', output_index: 0, delta: 'Hel' }),
    ...t.push({ type: 'response.output_text.delta', output_index: 0, delta: 'lo' }),
    ...t.push({ type: 'response.output_text.done', output_index: 0, text: 'Hello' }),
    ...t.push({ type: 'response.completed' }),
  ]
  assert.deepEqual(chunks[0], { type: 'block-start', index: 0, blockType: 'text' })
  assert.equal(chunks.filter((chunk) => chunk.type === 'block-start').length, 1, 'one run opens one block')
  assertStreamGrammar(chunks)
})

test('a successful finish closes a text run whose done event never arrived', () => {
  const t = new ResponsesEventTranslator()
  const chunks = [
    ...t.push({ type: 'response.output_text.delta', output_index: 0, delta: 'partial' }),
    ...t.push({ type: 'response.completed' }),
  ]
  const close = chunks.find((chunk) => chunk.type === 'block-end')
  assert.deepEqual(close, { type: 'block-end', index: 0, block: { type: 'text', text: 'partial' } })
  assertStreamGrammar(chunks)
})

test('a text run that only arrives as a done event still opens its block', () => {
  const t = new ResponsesEventTranslator()
  const chunks = [
    ...t.push({ type: 'response.output_text.done', output_index: 0, text: 'Hello' }),
    ...t.push({ type: 'response.completed' }),
  ]
  assert.deepEqual(chunks[0], { type: 'block-start', index: 0, blockType: 'text' })
  assert.equal(chunks[1].type, 'block-end')
  assertStreamGrammar(chunks)
})

test('mixed text and tool-call items never share a block index', () => {
  const t = new ResponsesEventTranslator()
  const chunks = [
    ...t.push({ type: 'response.output_item.added', output_index: 0, item: { id: 'fc_1', type: 'function_call', call_id: 'call_1', name: 'bash' } }),
    ...t.push({ type: 'response.function_call_arguments.delta', item_id: 'fc_1', call_id: 'call_1', delta: '{"cmd"' }),
    ...t.push({ type: 'response.function_call_arguments.done', item_id: 'fc_1', call_id: 'call_1', name: 'bash', arguments: '{"cmd":"ls"}' }),
    ...t.push({ type: 'response.output_text.delta', item_id: 'msg_1', output_index: 1, delta: 'done' }),
    ...t.push({ type: 'response.output_text.done', item_id: 'msg_1', output_index: 1, text: 'done' }),
    ...t.push({ type: 'response.completed' }),
  ]
  const starts = chunks.filter((chunk) => chunk.type === 'block-start')
  assert.equal(new Set(starts.map((chunk) => chunk.index)).size, starts.length, 'every block gets its own index')
  assertStreamGrammar(chunks)
})

test('a request never emits a chunk after its terminal finish', () => {
  const t = new ResponsesEventTranslator()
  t.push({ type: 'response.completed' })
  assert.deepEqual(t.push({ type: 'response.output_text.delta', output_index: 0, delta: 'late' }), [], 'a late delta is dropped')
  assert.deepEqual(t.push({ type: 'response.completed' }), [], 'a repeated terminal event adds nothing')
  assert.deepEqual(t.end(), [], 'the stream is already terminal')
})

test('a reopened item takes a fresh index instead of repeating block-start', () => {
  const t = new ResponsesEventTranslator()
  const chunks = [
    ...t.push({ type: 'response.function_call_arguments.done', item_id: 'fc_1', call_id: 'call_1', name: 'bash', arguments: '{}' }),
    ...t.push({ type: 'response.function_call_arguments.done', item_id: 'fc_1', call_id: 'call_1', name: 'bash', arguments: '{}' }),
    ...t.push({ type: 'response.completed' }),
  ]
  const starts = chunks.filter((chunk) => chunk.type === 'block-start')
  assert.equal(starts.length, 2)
  assert.notEqual(starts[0].index, starts[1].index)
  assertStreamGrammar(chunks)
})
