import test from 'node:test'
import assert from 'node:assert/strict'
import { buildResponsesRequest, buildResponsesTools, contentText } from '../src/provider/request-builder.js'

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
  assert.equal(request.store, false)
  assert.equal('max_output_tokens' in request, false, 'the codex endpoint rejects max_output_tokens')
  assert.equal(request.input.length, 2)
  assert.deepEqual(request.input[0], { role: 'user', content: [{ type: 'input_text', text: 'Hi' }] })
  assert.deepEqual(request.input[1], { role: 'assistant', content: [{ type: 'output_text', text: 'Hello' }] })
  assert.equal(request.tools[0].type, 'function')
})

test('buildResponsesRequest emits a tool result as a top-level function_call_output item', () => {
  const request = buildResponsesRequest({
    model: 'm',
    messages: [{
      role: 'user',
      content: [{ type: 'tool-result', toolCallId: 'call_1', content: [{ type: 'text', text: '42' }], isError: false }],
    }],
  })
  assert.deepEqual(request.input, [{ type: 'function_call_output', call_id: 'call_1', output: '42' }])
})

test('buildResponsesRequest emits assistant tool calls as top-level function_call items', () => {
  const request = buildResponsesRequest({
    model: 'm',
    messages: [
      { role: 'assistant', content: [
        { type: 'text', text: 'Running' },
        { type: 'tool-call', id: 'call_1|item_1', name: 'bash', arguments: '{"command":"ls"}' },
      ] },
      { role: 'user', content: [{ type: 'tool-result', toolCallId: 'call_1|item_1', content: [{ type: 'text', text: 'ok' }] }] },
    ],
  })
  assert.deepEqual(request.input, [
    { role: 'assistant', content: [{ type: 'output_text', text: 'Running' }] },
    { type: 'function_call', call_id: 'call_1', id: 'item_1', name: 'bash', arguments: '{"command":"ls"}' },
    { type: 'function_call_output', call_id: 'call_1', output: 'ok' },
  ])
})

test('buildResponsesRequest includes reasoning effort', () => {
  const request = buildResponsesRequest({ model: 'm', messages: [], reasoningEffort: 'high', stream: true })
  assert.deepEqual(request.reasoning, { effort: 'high' })
})

test('contentText works', () => {
  assert.equal(contentText([{ type: 'text', text: 'a' }]), 'a')
})

test('buildResponsesRequest withholds the sandbox-escalation lever from model-visible schemas', () => {
  const parameters = {
    type: 'object',
    properties: {
      command: { type: 'string' },
      description: { type: 'string' },
      workdir: { type: 'string' },
      sandbox_permissions: { type: 'string', enum: ['workspace-write', 'danger-full-access'] },
      justification: { type: 'string' },
    },
    required: ['command', 'description'],
  }
  const request = buildResponsesRequest({
    model: 'm',
    messages: [],
    tools: [{ name: 'pwsh', description: 'Run a command.', parameters }],
  })
  const tool = request.tools[0]
  assert.equal(tool.type, 'function')
  assert.deepEqual(Object.keys(tool.parameters.properties), ['command', 'description', 'workdir'])
  assert.deepEqual(tool.parameters.required, ['command', 'description'])
  assert.deepEqual(tool.parameters.properties.workdir, { type: 'string' })
  assert.ok(tool.description.includes('never set `sandbox_permissions`'))
  assert.ok(tool.description.includes('widen the permission preset'))
  // the caller's schema object is not mutated
  assert.deepEqual(Object.keys(parameters.properties), ['command', 'description', 'workdir', 'sandbox_permissions', 'justification'])
})

test('buildResponsesTools drops withheld names from required and leaves lever-less tools untouched', () => {
  const plain = { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] }
  const passthrough = buildResponsesTools([{ name: 'echo', description: 'd', parameters: plain }])
  assert.equal(passthrough[0].parameters, plain)
  assert.equal(passthrough[0].description, 'd')

  const projected = buildResponsesTools([{
    name: 'fs', description: 'Edit files.',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' }, sandbox_permissions: { type: 'string' }, justification: { type: 'string' } },
      required: ['path', 'sandbox_permissions'],
    },
  }])
  assert.deepEqual(Object.keys(projected[0].parameters.properties), ['path'])
  assert.deepEqual(projected[0].parameters.required, ['path'])
  assert.ok(projected[0].description.startsWith('Edit files.'))
})

test('buildResponsesTools tolerates schemas without a plain properties map', () => {
  const noParameters = buildResponsesTools([{ name: 'x', description: 'd', parameters: undefined }])
  assert.deepEqual(noParameters[0], { type: 'function', name: 'x', description: 'd', parameters: undefined })
  const noProperties = buildResponsesTools([{ name: 'y', description: 'd', parameters: { type: 'object' } }])
  assert.deepEqual(noProperties[0].parameters, { type: 'object' })
})
