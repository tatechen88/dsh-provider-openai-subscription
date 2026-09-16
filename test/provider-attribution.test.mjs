import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  FALLBACK_USER_AGENT,
  attributionHeaders,
  resetAttributionCache,
  resolveAttributionHeaders,
} from '../src/provider/attribution.js'

test('the harness helper wins whenever it is importable', async () => {
  const headers = await resolveAttributionHeaders(async () => ({
    attributionHeaders: () => ({ 'user-agent': 'deepseek-harness/9.9.9 (+https://example.test)' }),
  }))
  assert.deepEqual(headers, { 'user-agent': 'deepseek-harness/9.9.9 (+https://example.test)' })
})

test('the fallback keeps a versioned header when the harness package is unreachable', async () => {
  const headers = await resolveAttributionHeaders(async () => { throw new Error('ERR_MODULE_NOT_FOUND') })
  assert.deepEqual(headers, { 'user-agent': FALLBACK_USER_AGENT })
  assert.match(FALLBACK_USER_AGENT, /^dsh-provider-openai-subscription\/\d+\.\d+\.\d+ \(\+https:\/\//)
})

test('a malformed helper result is refused rather than sent', async () => {
  for (const bad of [undefined, null, {}, 'nope', { 'user-agent': 7 }]) {
    const headers = await resolveAttributionHeaders(async () => ({ attributionHeaders: () => bad }))
    assert.deepEqual(headers, { 'user-agent': FALLBACK_USER_AGENT }, `helper result ${JSON.stringify(bad)} must be refused`)
  }
})

test('a module without the helper falls back', async () => {
  assert.deepEqual(
    await resolveAttributionHeaders(async () => ({ somethingElse: 1 })),
    { 'user-agent': FALLBACK_USER_AGENT },
  )
})

test('the real loader reaches a harness package installed under DSH_HOME', async () => {
  // A `link:`-installed checkout cannot walk up to the profile's packages, which
  // is the layout this plugin is actually deployed in. The harness home is the
  // anchor that covers it.
  const home = await mkdtemp(join(tmpdir(), 'attribution-home-'))
  const previous = process.env.DSH_HOME
  try {
    const pkgDir = join(home, 'profiles', 'node_modules', '@deepseek-ai', 'dsh-llm')
    await mkdir(pkgDir, { recursive: true })
    await writeFile(join(pkgDir, 'package.json'), JSON.stringify({
      name: '@deepseek-ai/dsh-llm',
      version: '0.0.0-fixture',
      type: 'module',
      main: 'index.js',
    }))
    await writeFile(join(pkgDir, 'index.js'), [
      'export function attributionHeaders() {',
      "  return { 'user-agent': 'deepseek-harness/0.0.0-fixture (+https://fixture.invalid)' }",
      '}',
      '',
    ].join('\n'))

    process.env.DSH_HOME = home
    resetAttributionCache()
    // The default loader, not a seam: this is the resolution path the plugin runs.
    assert.deepEqual(
      await resolveAttributionHeaders(),
      { 'user-agent': 'deepseek-harness/0.0.0-fixture (+https://fixture.invalid)' },
    )
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    resetAttributionCache()
    await rm(home, { recursive: true, force: true })
  }
})

test('the memoized headers resolve once for the process', async () => {
  resetAttributionCache()
  // Which identity wins depends on whether a harness is installed around this
  // checkout, so this asserts the caching contract rather than a value.
  const first = await attributionHeaders()
  const second = await attributionHeaders()
  assert.equal(first, second, 'the resolved record is reused')
  assert.equal(typeof first['user-agent'], 'string')
  assert.ok(first['user-agent'].length > 0)
  resetAttributionCache()
  assert.notEqual(await attributionHeaders(), first, 'resetting the cache re-resolves')
  resetAttributionCache()
})
