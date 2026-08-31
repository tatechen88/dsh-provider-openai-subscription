import test from 'node:test'
import assert from 'node:assert/strict'
import { parseCallbackInput } from '../src/oauth/callback-parser.js'

test('parseCallbackInput parses full URL', () => {
  const parsed = parseCallbackInput('http://localhost:1455/auth/callback?code=abc&state=xyz')
  assert.equal(parsed.kind, 'url')
  assert.equal(parsed.code, 'abc')
  assert.equal(parsed.state, 'xyz')
})

test('parseCallbackInput reads fragment parameters when no query code', () => {
  const parsed = parseCallbackInput('http://localhost:1455/auth/callback#code=abc&state=xyz')
  assert.equal(parsed.kind, 'url')
  assert.equal(parsed.code, 'abc')
  assert.equal(parsed.state, 'xyz')
})

test('parseCallbackInput parses query string', () => {
  const parsed = parseCallbackInput('?code=abc&state=xyz')
  assert.equal(parsed.kind, 'query')
  assert.equal(parsed.code, 'abc')
  assert.equal(parsed.state, 'xyz')
})

test('parseCallbackInput parses raw code with optional state after #', () => {
  assert.deepEqual(parseCallbackInput('code123'), { kind: 'raw', code: 'code123', state: undefined })
  const parsed = parseCallbackInput('code123#state456')
  assert.equal(parsed.kind, 'raw')
  assert.equal(parsed.code, 'code123')
  assert.equal(parsed.state, 'state456')
})

test('parseCallbackInput handles empty and non-code input', () => {
  assert.deepEqual(parseCallbackInput(''), { kind: 'raw' })
  assert.deepEqual(parseCallbackInput('   '), { kind: 'raw' })
  // A non-URL, non-query value is treated as a raw authorization code.
  assert.equal(parseCallbackInput('hello').code, 'hello')
})
