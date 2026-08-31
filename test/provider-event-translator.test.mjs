import test from 'node:test'
import assert from 'node:assert/strict'
import { ResponsesEventTranslator } from '../src/provider/event-translator.js'

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
