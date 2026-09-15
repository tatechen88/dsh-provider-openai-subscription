/**
 * Collector contracts for the built-in usage meter.
 *
 * @module dsh-provider-openai-subscription/test/usage-collector
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { createUsageCollector } from '../src/usage/collector.js'

/** Build an async iterable from a fixed chunk list. */
function source(chunks, onReturn) {
  return {
    [Symbol.asyncIterator]() {
      let index = 0
      return {
        async next() {
          if (index >= chunks.length) return { done: true, value: undefined }
          return { done: false, value: chunks[index++] }
        },
        async return() {
          onReturn?.()
          return { done: true, value: undefined }
        },
      }
    },
  }
}

/** Drain one async iterable. */
async function drain(iterable) {
  const out = []
  for await (const chunk of iterable) out.push(chunk)
  return out
}

test('collector forwards every chunk and records the final usage', async () => {
  const facts = []
  const collector = createUsageCollector({ record: (fact) => facts.push(fact), now: () => 1000, createCallId: () => 'call-a' })
  const chunks = [
    { type: 'text-delta', index: 0, text: 'hi' },
    { type: 'usage', usage: { inputTokens: 10, outputTokens: 2, cacheReadTokens: 90 } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
  const seen = await drain(collector(
    { provider: 'deepseek-official', model: 'deepseek-flash', sessionId: 's1' },
    () => source(chunks),
  ))
  assert.deepEqual(seen, chunks, 'every chunk reaches the consumer unchanged')
  assert.equal(facts.length, 1)
  assert.equal(facts[0].callId, 'call-a')
  assert.equal(facts[0].provider, 'deepseek-official')
  assert.equal(facts[0].model, 'deepseek-flash')
  assert.equal(facts[0].sessionId, 's1')
  assert.equal(facts[0].startedAt, 1000)
  assert.deepEqual(facts[0].usage, chunks[1].usage)
})

test('collector records nothing for an unmetered route or a usage-less stream', async () => {
  const facts = []
  const collector = createUsageCollector({ record: (fact) => facts.push(fact) })

  await drain(collector({ provider: 'deepseek', model: 'x' }, () => source([{ type: 'usage', usage: { inputTokens: 5, outputTokens: 1 } }])))
  await drain(collector({ provider: 'deepseek-official', model: 'x' }, () => source([{ type: 'text-delta', index: 0, text: 'no usage' }])))
  assert.deepEqual(facts, [], 'missing usage is not zero usage')
})

test('collector keeps a nested router call on the outer record', async () => {
  const facts = []
  let innerSeen = 0
  const collector = createUsageCollector({ record: (fact) => facts.push(fact), createCallId: () => `call-${facts.length}` })

  const inner = () => source([{ type: 'usage', usage: { inputTokens: 7, outputTokens: 1 } }])
  const outer = {
    [Symbol.asyncIterator]() {
      let done = false
      return {
        async next() {
          if (done) return { done: true, value: undefined }
          done = true
          // A routing adapter re-enters the same waterfall from inside its own
          // pull; that nested stream must not bill a second time.
          for await (const chunk of collector({ provider: 'deepseek-official', model: 'm' }, inner)) innerSeen += 1
          return { done: false, value: { type: 'usage', usage: { inputTokens: 7, outputTokens: 1 } } }
        },
      }
    },
  }
  await drain(collector({ provider: 'deepseek-official', model: 'm' }, () => outer))
  assert.equal(innerSeen, 1)
  assert.equal(facts.length, 1, 'the same tokens are billed once')
})

test('collector isolates concurrent calls and closes an abandoned stream', async () => {
  const facts = []
  let closed = false
  const collector = createUsageCollector({ record: (fact) => facts.push(fact), createCallId: (() => { let n = 0; return () => `call-${++n}` })() })

  const first = collector({ provider: 'deepseek-official', model: 'a' }, () => source([
    { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } },
  ], () => { closed = true }))
  const second = collector({ provider: 'openai-subscription', model: 'b' }, () => source([
    { type: 'usage', usage: { inputTokens: 2, outputTokens: 2 } },
  ]))

  // Consume two chunks of the first stream, then abandon it mid-flight.
  const iterator = first[Symbol.asyncIterator]()
  const firstChunk = await iterator.next()
  assert.equal(firstChunk.done, false)
  await iterator.return?.()

  // A second call still completes normally with its own usage.
  assert.equal((await drain(second)).length, 1)

  const byModel = Object.fromEntries(facts.map((entry) => [entry.model, entry.usage]))
  assert.deepEqual(byModel.a, { inputTokens: 1, outputTokens: 1 }, 'the abandoned call still reports what it spent')
  assert.deepEqual(byModel.b, { inputTokens: 2, outputTokens: 2 }, 'the concurrent call keeps its own usage')
  assert.equal(closed, true, 'the abandoned stream is closed downstream')
})
