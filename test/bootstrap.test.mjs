import test from 'node:test'
import assert from 'node:assert/strict'
import { activateSafely, applyBootstrap } from '../src/bootstrap.js'
import { normalizeConfig } from '../src/config.js'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const originalHome = process.env.DSH_HOME
const dirs = []

test.beforeEach(async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-openai-subscription-bootstrap-'))
  dirs.push(dir)
  process.env.DSH_HOME = dir
})

test.afterEach(async () => {
  if (originalHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = originalHome
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

function fakeCtx(logs = []) {
  return {
    logger: {
      info: (...args) => logs.push(['info', ...args]),
      warn: (...args) => logs.push(['warn', ...args]),
      error: (...args) => logs.push(['error', ...args]),
    },
  }
}

test('bootstrap state does not load runtime', async () => {
  const logs = []
  const ctx = fakeCtx(logs)
  let loaded = false
  const result = await activateSafely(ctx, { state: 'bootstrap', oauth: { clientId: 'abc' } }, async () => {
    loaded = true
    return { applyRuntime: async () => {} }
  })
  assert.equal(result.loaded, false)
  assert.equal(loaded, false)
})

test('disabled state does not load runtime', async () => {
  let loaded = false
  const result = await activateSafely(fakeCtx(), { state: 'disabled' }, async () => {
    loaded = true
    return { applyRuntime: async () => {} }
  })
  assert.equal(result.loaded, false)
  assert.equal(loaded, false)
})

test('active state without client id does not load runtime', async () => {
  let loaded = false
  const result = await activateSafely(fakeCtx(), { state: 'active', oauth: { clientId: '' } }, async () => {
    loaded = true
    return { applyRuntime: async () => {} }
  })
  assert.equal(result.loaded, false)
  assert.equal(loaded, false)
})

test('active state with client id loads and runs runtime', async () => {
  let applied = false
  const result = await activateSafely(fakeCtx(), { state: 'active', oauth: { clientId: 'abc' } }, async () => ({
    applyRuntime: async () => {
      applied = true
    },
  }))
  assert.equal(result.loaded, true)
  assert.equal(applied, true)
})

test('kill switch prevents runtime even in active state', async () => {
  const state = await import('../src/state.js')
  await state.enableKillSwitch()
  let loaded = false
  const result = await activateSafely(fakeCtx(), { state: 'active', oauth: { clientId: 'abc' } }, async () => {
    loaded = true
    return { applyRuntime: async () => {} }
  })
  assert.equal(result.loaded, false)
  assert.equal(result.reason, 'kill-switch')
  assert.equal(loaded, false)
})

test('runtime import failure is contained', async () => {
  const logs = []
  const ctx = fakeCtx(logs)
  const result = await activateSafely(ctx, { state: 'active', oauth: { clientId: 'abc' } }, async () => {
    throw new Error('synthetic import failure')
  })
  assert.equal(result.loaded, false)
  assert.equal(result.reason, 'runtime-failed')
  assert.equal(logs.some(([level]) => level === 'error'), true)
})

test('runtime applyRuntime rejection is contained', async () => {
  const result = await activateSafely(fakeCtx(), { state: 'active', oauth: { clientId: 'abc' } }, async () => ({
    applyRuntime: async () => {
      throw new Error('synthetic runtime failure')
    },
  }))
  assert.equal(result.loaded, false)
  assert.equal(result.reason, 'runtime-failed')
})

test('applyBootstrap is synchronous and does not throw on active runtime failure', () => {
  const originalImport = globalThis.__dshTestImport
  globalThis.__dshTestImport = async () => {
    throw new Error('synthetic')
  }
  try {
    // activateSafely uses the default dynamicImport, so this only proves the
    // public apply wrapper does not synchronously throw. The contained async
    // path is covered by the activateSafely tests above.
    assert.doesNotThrow(() => applyBootstrap(fakeCtx(), { state: 'active', oauth: { clientId: 'abc' } }))
  } finally {
    if (originalImport === undefined) delete globalThis.__dshTestImport
    else globalThis.__dshTestImport = originalImport
  }
})

test('normalizeConfig is stable through activateSafely', async () => {
  const seen = []
  await activateSafely(fakeCtx(), { state: 'active', oauth: { clientId: 'abc' }, extra: true }, async (specifier) => {
    assert.equal(specifier, './runtime.js')
    return {
      applyRuntime: async (ctx, config) => {
        seen.push(config)
      },
    }
  })
  assert.equal(seen.length, 1)
  assert.equal(seen[0].extra, true)
  assert.equal(seen[0].state, 'active')
  assert.equal(normalizeConfig(seen[0]).oauth.clientId, 'abc')
})
