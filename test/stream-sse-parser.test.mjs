import test from 'node:test'
import assert from 'node:assert/strict'
import { SseParser } from '../src/stream/sse-parser.js'

test('SseParser parses one data event', () => {
  const parser = new SseParser()
  const events = parser.push('data: hello\n\n')
  assert.deepEqual(events, [{ data: 'hello' }])
})

test('SseParser parses event name and multiline data', () => {
  const parser = new SseParser()
  const events = parser.push('event: response.output_text.delta\ndata: {"a":1}\ndata: {"b":2}\n\n')
  assert.deepEqual(events, [{ event: 'response.output_text.delta', data: '{"a":1}\n{"b":2}' }])
})

test('SseParser handles CRLF', () => {
  const parser = new SseParser()
  const events = parser.push('data: x\r\ndata: y\r\n\r\n')
  assert.deepEqual(events, [{ data: 'x\ny' }])
})

test('SseParser ignores comments and empty data', () => {
  const parser = new SseParser()
  const events = parser.push(': keepalive\ndata:\n\n')
  assert.deepEqual(events, [])
})

test('SseParser handles chunks split anywhere', () => {
  const parser = new SseParser()
  const all = 'event: e\ndata: one\n\n'
  const events = []
  for (const char of all) {
    events.push(...parser.push(char))
  }
  assert.deepEqual(events, [{ event: 'e', data: 'one' }])
})

test('SseParser end flushes trailing event without newline', () => {
  const parser = new SseParser()
  parser.push('data: tail')
  assert.deepEqual(parser.end(), [{ data: 'tail' }])
})

test('SseParser emits [DONE] as data', () => {
  const parser = new SseParser()
  const events = parser.push('data: [DONE]\n\n')
  assert.deepEqual(events, [{ data: '[DONE]' }])
})
