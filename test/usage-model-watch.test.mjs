import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  extractModelIds,
  newModelIds,
  ModelWatchStore,
  ModelWatchService,
  MODEL_WATCH_TTL_MS,
} from '../src/usage/model-watch.js'
import { modelWatchPath } from '../src/state.js'

const directory = () => mkdtemp(join(tmpdir(), 'usage-model-watch-'))

/** A store pointed at a throwaway home. */
const store = async () => {
  const opened = new ModelWatchStore({ path: modelWatchPath(await directory()) })
  await opened.open()
  return opened
}

test('extractModelIds reads the three directory shapes and refuses to guess', () => {
  assert.deepEqual(extractModelIds({ object: 'list', data: [{ id: 'deepseek-flash' }, { id: 'deepseek-v4-pro' }] }), {
    ok: true,
    ids: ['deepseek-flash', 'deepseek-v4-pro'],
  })
  assert.deepEqual(extractModelIds({ data: { items: [{ id: 'glm-5' }] } }), { ok: true, ids: ['glm-5'] })
  assert.deepEqual(extractModelIds(['a', 'b']), { ok: true, ids: ['a', 'b'] })
  assert.equal(extractModelIds({ success: false }).ok, false)
  assert.equal(extractModelIds({ hello: 1 }).ok, false)
  // Duplicates collapse: a station listing one model twice is one model.
  assert.deepEqual(extractModelIds({ data: [{ id: 'a' }, { id: 'a' }] }), { ok: true, ids: ['a'] })
})

test('newModelIds names only the ids the baseline lacks', () => {
  assert.deepEqual(newModelIds({ a: 1, b: 2 }, ['a', 'c']), ['c'])
  assert.deepEqual(newModelIds({}, ['a']), ['a'])
})

test('the first scan becomes the baseline instead of flagging everything new', async () => {
  const watch = new ModelWatchService({
    store: await store(),
    readDeepSeekCredential: async () => ({ apiKey: 'sk-test' }),
    fetchImpl: async () => Response.json({ data: [{ id: 'deepseek-flash' }] }),
  })
  const view = await watch.scan()
  const deepseek = view.vendors.find((entry) => entry.vendor === 'deepseek')
  assert.equal(deepseek.status, 'ok')
  assert.equal(deepseek.total, 1)
  assert.deepEqual(deepseek.newModels, [])
})

test('a model added between scans is named, and acknowledging clears the mark', async () => {
  const path = modelWatchPath(await directory())
  const opened = new ModelWatchStore({ path })
  await opened.open()
  const watch = new ModelWatchService({
    store: opened,
    readDeepSeekCredential: async () => ({ apiKey: 'sk-test' }),
    fetchImpl: async () => Response.json({ data: [{ id: 'deepseek-flash' }] }),
  })
  await watch.scan({ force: true })

  // The directory gains a model, and the catalog also loses one: a retired
  // name leaving the baseline is kept — it may still be served and metered.
  let served = { data: [{ id: 'deepseek-flash' }, { id: 'deepseek-v5' }] }
  const second = new ModelWatchService({
    store: opened,
    readDeepSeekCredential: async () => ({ apiKey: 'sk-test' }),
    fetchImpl: async () => Response.json(served),
  })
  const view = await second.scan({ force: true })
  const deepseek = view.vendors.find((entry) => entry.vendor === 'deepseek')
  assert.deepEqual(deepseek.newModels.map((entry) => entry.id), ['deepseek-v5'])

  const after = await second.acknowledge()
  assert.deepEqual(after.vendors.find((entry) => entry.vendor === 'deepseek').newModels, [])
})

test('a failed scan keeps the previous baseline and reports why', async () => {
  const opened = new ModelWatchStore({ path: modelWatchPath(await directory()) })
  await opened.open()
  const good = new ModelWatchService({
    store: opened,
    readDeepSeekCredential: async () => ({ apiKey: 'sk-test' }),
    fetchImpl: async () => Response.json({ data: [{ id: 'deepseek-flash' }] }),
  })
  await good.scan({ force: true })

  const bad = new ModelWatchService({
    store: opened,
    readDeepSeekCredential: async () => ({ apiKey: 'sk-test' }),
    fetchImpl: async () => new Response('nope', { status: 503 }),
  })
  const view = await bad.scan({ force: true })
  const deepseek = view.vendors.find((entry) => entry.vendor === 'deepseek')
  assert.equal(deepseek.status, 'error')
  assert.equal(deepseek.total, 1)
  assert.match(deepseek.lastError, /HTTP 503/)
})

test('a vendor without a key is skipped, not failed', async () => {
  const watch = new ModelWatchService({
    store: await store(),
    readDeepSeekCredential: async () => ({ apiKey: undefined }),
    fetchImpl: async () => { throw new Error('must not be called') },
  })
  const view = await watch.scan()
  const deepseek = view.vendors.find((entry) => entry.vendor === 'deepseek')
  assert.equal(deepseek.status, 'ok')
  assert.equal(deepseek.total, 0)
  assert.equal(deepseek.lastError, undefined)
})

test('the OpenAI subscription catalog arrives through the injected adapter', async () => {
  const watch = new ModelWatchService({
    store: await store(),
    listOpenAIModels: async () => [{ id: 'gpt-5.2' }, { id: 'gpt-5.2-codex' }],
    fetchImpl: async () => { throw new Error('must not be called') },
  })
  const view = await watch.scan()
  const openai = view.vendors.find((entry) => entry.vendor === 'openai-subscription')
  assert.equal(openai.total, 2)
  assert.equal(openai.status, 'ok')
})

test('due() follows the last completed scan, and the baseline survives a restart', async () => {
  const path = modelWatchPath(await directory())
  const opened = new ModelWatchStore({ path })
  await opened.open()
  let clock = 1_000_000
  const watch = new ModelWatchService({
    store: opened,
    now: () => clock,
    readDeepSeekCredential: async () => ({ apiKey: 'sk-test' }),
    fetchImpl: async () => Response.json({ data: [{ id: 'deepseek-flash' }] }),
  })
  assert.equal(watch.due(), true)
  await watch.scan({ force: true })
  assert.equal(watch.due(), false)
  clock += MODEL_WATCH_TTL_MS
  assert.equal(watch.due(), true)

  // A second process reads the same file and keeps the baseline.
  const reopened = new ModelWatchStore({ path })
  await reopened.open()
  assert.equal(reopened.vendor('deepseek').known['deepseek-flash'], 1_000_000)
  const payload = JSON.parse(await readFile(path, 'utf8'))
  assert.equal(payload.schemaVersion, 1)
})
