import test from 'node:test'
import assert from 'node:assert/strict'
import { buildResponsesRequest, contentText, contentToolCalls } from '../src/provider/request-builder.js'

test('buildResponsesRequest builds text and tools body', () => {
  const request = buildResponsesRequest({
    model: 'gpt-5',
    system: 'You are helpful',
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'Hi' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'Hello' }] },
    ],
    tools: [{ name: 'bash', description: 'Run bash', parameters: { type: 'object', properties: {} } }],
    maxTokens: 100,
    stream: true,
  })
  assert.equal(request.model, 'gpt-5')
  assert.equal(request.instructions, 'You are helpful')
  assert.equal(request.stream, true)
  assert.equal(request.max_output_tokens, 100)
  assert.equal(request.input.length, 2)
  assert.equal(request.tools[0].type, 'function')
})

test('buildResponsesRequest maps tool result to function_call_output', () => {
  const request = buildResponsesRequest({
    model: 'm',
    messages: [{
      role: 'user',
      content: [{ type: 'tool-result', toolCallId: 'call_1', content: [{ type: 'text', text: '42' }], isError: false }],
    }],
  })
  assert.equal(request.input[0].content[0].type, 'function_call_output')
  assert.equal(request.input[0].content[0].call_id, 'call_1')
  assert.equal(request.input[0].content[0].output, '42')
})

test('buildResponsesRequest includes reasoning effort', () => {
  const request = buildResponsesRequest({ model: 'm', messages: [], reasoningEffort: 'high', stream: true })
  assert.deepEqual(request.reasoning, { effort: 'high' })
})

test('contentText and contentToolCalls helpers work', () => {
  assert.equal(contentText([{ type: 'text', text: 'a' }]), 'a')
  assert.deepEqual(contentToolCalls([{ type: 'tool-call', name: 'x', arguments: '{}' }]), [{ type: 'function_call', name: 'x', arguments: '{}' }])
})
