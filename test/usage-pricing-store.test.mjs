/**
 * The learned price table on disk.
 *
 * It is a cache: deleting it must only mean the built-in snapshot prices calls
 * again, so every unreadable state is reported and then ignored instead of
 * repaired. What it must not do is lose the reason a refresh failed, or the
 * operator has no way to learn that new models stopped being priced.
 *
 * @module dsh-provider-openai-subscription/test/usage-pricing-store
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LearnedPriceStore, LEARNED_PRICE_SCHEMA_VERSION } from '../src/usage/pricing-store.js'

/** A fresh store path in its own directory. */
async function storePath() {
  const dir = await mkdtemp(join(tmpdir(), 'usage-pricing-store-'))
  return join(dir, 'prices.json')
}

/** One schedule in the shape the parser produces. */
function schedule(overrides = {}) {
  return {
    id: 'deepseek-public-2026-09-20',
    provider: 'deepseek-official',
    status: 'official-current',
    currency: 'CNY',
    sourceUrl: 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing/',
    retrievedAt: '2026-09-20',
    models: { 'deepseek-v5': { offPeak: { cacheHit: 20_000, cacheMiss: 1_000_000, output: 4_000_000 } } },
    ...overrides,
  }
}

test('a saved table comes back whole, and left no temporary file behind', async () => {
  const path = await storePath()
  let clock = 1_000
  const store = new LearnedPriceStore({ path, now: () => clock })
  await store.save(schedule())
  clock = 2_000

  const reopened = new LearnedPriceStore({ path, now: () => clock })
  const state = await reopened.open()
  assert.deepEqual(state, { loaded: true })
  assert.deepEqual(reopened.schedule, schedule())
  assert.equal(reopened.fetchedAt, 1_000)
  assert.equal(reopened.lastAttemptAt, 1_000)
  assert.equal(reopened.lastError, undefined)

  const files = await readdir(join(path, '..'))
  assert.deepEqual(files.filter((name) => name.includes('.tmp-')), [], 'writes go through a rename, never a half-written file')
  assert.equal(JSON.parse(await readFile(path, 'utf8')).schemaVersion, LEARNED_PRICE_SCHEMA_VERSION)
})

test('a cache that cannot be read is reported and then ignored', async () => {
  const path = await storePath()
  const store = new LearnedPriceStore({ path })

  assert.deepEqual(await store.open(), { loaded: false }, 'a missing file is not an error')
  assert.equal(store.schedule, undefined)

  await writeFile(path, '{ not json')
  const broken = new LearnedPriceStore({ path })
  const brokenState = await broken.open()
  assert.equal(brokenState.loaded, false)
  assert.equal(typeof brokenState.reason, 'string')
  assert.equal(broken.schedule, undefined, 'a broken cache never becomes a price')

  await writeFile(path, JSON.stringify({ schemaVersion: 99, schedule: schedule() }))
  assert.deepEqual(await new LearnedPriceStore({ path }).open(), { loaded: false, reason: 'unsupported-schema' })

  await writeFile(path, JSON.stringify({ schemaVersion: LEARNED_PRICE_SCHEMA_VERSION, schedule: { id: 'x' } }))
  assert.deepEqual(
    await new LearnedPriceStore({ path }).open(),
    { loaded: false },
    'a schedule without a provider and a model map is not one this meter can use',
  )
})

test('a failed refresh keeps the table in force and remembers why', async () => {
  const path = await storePath()
  let clock = 1_000
  const store = new LearnedPriceStore({ path, now: () => clock })
  await store.save(schedule())
  clock = 5_000
  await store.recordFailure('missing-rate:deepseek-v5.output.peak')

  assert.deepEqual(store.schedule, schedule(), 'the previous table is still the one in force')
  assert.equal(store.lastAttemptAt, 5_000)
  assert.equal(store.lastError, 'missing-rate:deepseek-v5.output.peak')

  const reopened = new LearnedPriceStore({ path, now: () => clock })
  await reopened.open()
  assert.equal(reopened.lastError, 'missing-rate:deepseek-v5.output.peak', 'and the reason outlives the process')
  assert.deepEqual(reopened.schedule, schedule())
})

test('a refresh is due only after its interval has passed', async () => {
  const path = await storePath()
  let clock = 1_000
  const store = new LearnedPriceStore({ path, now: () => clock })
  assert.equal(store.due(86_400_000), true, 'nothing has been attempted yet')
  await store.recordFailure('http:503')
  assert.equal(store.due(86_400_000), false, 'a failure backs off like a success does')
  clock = 1_000 + 86_400_000
  assert.equal(store.due(86_400_000), true)
})
