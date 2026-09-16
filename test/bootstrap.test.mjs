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

test('active state without client id refuses to load and reports why', async () => {
  let loaded = false
  const logs = []
  const result = await activateSafely(fakeCtx(logs), { state: 'active', oauth: { clientId: '' } }, async () => {
    loaded = true
    return { applyRuntime: async () => {} }
  })
  assert.equal(result.loaded, false)
  assert.equal(loaded, false)
  assert.equal(result.reason, 'invalid-active-config')
  assert.match(result.error.message, /oauth\.clientId is empty/)
  assert.equal(logs.some(([level]) => level === 'error'), true)
})

test('active state with client id loads and runs runtime', async () => {
  let applied = false
  const result = await activateSafely(fakeCtx(), { state: 'active', oauth: { clientId: 'abc' } }, async () => ({
    applyRuntime: async () => {
      applied = true
      return { ok: true }
    },
  }))
  assert.equal(result.loaded, true)
  assert.equal(result.error, undefined)
  assert.equal(applied, true)
})

test('a runtime that reports itself unavailable is an activation failure', async () => {
  const logs = []
  const result = await activateSafely(fakeCtx(logs), { state: 'active', oauth: { clientId: 'abc' } }, async () => ({
    applyRuntime: async () => ({ ok: false, reason: 'no-credentials' }),
  }))
  assert.equal(result.loaded, false)
  assert.equal(result.reason, 'runtime-unavailable')
  assert.match(result.error.message, /no-credentials/)
  assert.equal(logs.some(([level]) => level === 'error'), true)
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
  assert.equal(result.error, undefined, 'the kill switch is a user choice, not a failure')
  assert.equal(loaded, false)
})

test('runtime import failure is reported as a failure', async () => {
  const logs = []
  const ctx = fakeCtx(logs)
  const result = await activateSafely(ctx, { state: 'active', oauth: { clientId: 'abc' } }, async () => {
    throw new Error('synthetic import failure')
  })
  assert.equal(result.loaded, false)
  assert.equal(result.reason, 'runtime-import-failed')
  assert.match(result.error.message, /runtime module could not be imported/)
  assert.equal(logs.some(([level]) => level === 'error'), true)
})

test('a runtime module without applyRuntime is a failure', async () => {
  const result = await activateSafely(fakeCtx(), { state: 'active', oauth: { clientId: 'abc' } }, async () => ({}))
  assert.equal(result.loaded, false)
  assert.equal(result.reason, 'runtime-import-failed')
  assert.equal(result.error instanceof TypeError, true)
})

test('runtime applyRuntime rejection is reported as a failure', async () => {
  const result = await activateSafely(fakeCtx(), { state: 'active', oauth: { clientId: 'abc' } }, async () => ({
    applyRuntime: async () => {
      throw new Error('synthetic runtime failure')
    },
  }))
  assert.equal(result.loaded, false)
  assert.equal(result.reason, 'runtime-apply-failed')
  assert.match(result.error.message, /runtime failed to activate/)
})

test('applyBootstrap resolves for an inactive row and rejects for a failed one', async () => {
  // Inactive rows are a normal no-op: the entry activates and contributes nothing.
  await assert.doesNotReject(applyBootstrap(fakeCtx(), { state: 'bootstrap', oauth: { clientId: 'abc' } }))
  await assert.doesNotReject(applyBootstrap(fakeCtx(), { state: 'disabled' }))
  // An explicitly active row that cannot activate rejects, so DSH's startup
  // audit reports it instead of showing a silent success.
  await assert.rejects(
    applyBootstrap(fakeCtx(), { state: 'active', oauth: { clientId: 'abc' } }),
    /did not activate/,
  )
})

test('applyBootstrap rejects an active row with no client id', async () => {
  await assert.rejects(
    applyBootstrap(fakeCtx(), { state: 'active', oauth: { clientId: '' } }),
    /oauth\.clientId is empty/,
  )
})

test('normalizeConfig is stable through activateSafely', async () => {
  const seen = []
  await activateSafely(fakeCtx(), { state: 'active', oauth: { clientId: 'abc' }, extra: true }, async (specifier) => {
    assert.equal(specifier, './runtime.js')
    return {
      applyRuntime: async (ctx, config) => {
        seen.push(config)
        return { ok: true }
      },
    }
  })
  assert.equal(seen.length, 1)
  assert.equal(seen[0].extra, true)
  assert.equal(seen[0].state, 'active')
  assert.equal(normalizeConfig(seen[0]).oauth.clientId, 'abc')
})
