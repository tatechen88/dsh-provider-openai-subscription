#!/usr/bin/env node
/**
 * Real DSH composition smoke test.
 *
 * This script composes the plugin into a real Cordis context using the DSH
 * packages from an installed profile.  It does not require OAuth credentials
 * and does not touch a real profile: every path it writes lives inside a
 * temporary directory that is removed at the end.
 *
 * It proves three things the unit tests cannot:
 *   1. the plugin activates inside a real DSH context and registers its provider;
 *   2. the usage meter's `llm/stream` listener is reached by the real waterfall,
 *      so a completed call becomes a priced fact in the ledger;
 *   3. a bootstrap-state plugin still loads no runtime at all.
 *
 * Usage:
 *   DSH_NODE_MODULES="/path/to/dsh/profiles/node_modules" \
 *     node scripts/integration-smoke.mjs
 *
 * If DSH_NODE_MODULES is omitted, the script derives the profile's
 * `node_modules` from DSH_PROFILE, then from DSH_HOME's profiles.  No
 * machine-specific path is used as a default, and a missing or partial install
 * is reported as SKIP rather than a failure.
 */

import { createRequire } from 'node:module'
import { mkdtemp, readFile, rm, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { activateSafely } from '../src/bootstrap.js'

const here = dirname(fileURLToPath(import.meta.url))
const pluginRoot = join(here, '..')

/**
 * Find the installed DSH dependency surface without assuming a host path.
 * @returns {Promise<{path: string|undefined, checked: string[]}>}
 */
async function findDshNodeModules() {
  const profile = process.env.DSH_PROFILE
  const home = process.env.DSH_HOME
  const candidates = [
    process.env.DSH_NODE_MODULES,
    profile === undefined ? undefined : basename(profile) === 'node_modules' ? profile : join(profile, 'node_modules'),
    home === undefined ? undefined : join(home, 'profiles', 'node_modules'),
    home === undefined ? undefined : join(home, 'profiles', 'web', 'node_modules'),
    home === undefined ? undefined : join(home, 'profiles', 'default', 'node_modules'),
    home === undefined ? undefined : join(home, 'node_modules'),
  ].filter((candidate, index, all) => candidate !== undefined && candidate.length > 0 && all.indexOf(candidate) === index)

  for (const candidate of candidates) {
    try {
      await access(join(candidate, '@deepseek-ai', 'cordis', 'package.json'))
      return { path: candidate, checked: candidates }
    } catch {
      // Continue checking the remaining installation locations.
    }
  }
  return { path: undefined, checked: candidates }
}

const dshModules = await findDshNodeModules()
if (dshModules.path === undefined) {
  console.log(`SKIP: DSH packages not found; checked ${dshModules.checked.join(', ') || 'no configured locations'}`)
  process.exit(0)
}
const dshNodeModules = dshModules.path

const require = createRequire(join(dshNodeModules, 'noop.js'))
let Context
let LocalCredentialProvider
let LlmRuntime
try {
  ;({ Context } = require('@deepseek-ai/cordis'))
  ;({ LocalCredentialProvider } = require('@deepseek-ai/dsh-credentials-local'))
  ;({ LlmRuntime } = require('@deepseek-ai/dsh-llm'))
} catch (error) {
  // A partial install is a skip, not a crash: the point of the script is to
  // exercise a real composition when one is available.
  console.log(`SKIP: DSH packages are incomplete under ${dshNodeModules} (${error instanceof Error ? error.message : String(error)})`)
  process.exit(0)
}

/** One stream of chunks for the fake adapter below. */
function fakeStream() {
  return (async function* generate() {
    yield { type: 'text-delta', index: 0, text: 'hello' }
    yield { type: 'usage', usage: { inputTokens: 1_000_000, outputTokens: 0 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  })()
}

/**
 * A minimal adapter for the DeepSeek route so the real waterfall can be driven
 * without a network call or a credential.
 * @param {string} provider
 * @returns {object} the adapter surface LlmRuntime dispatches to.
 */
function fakeAdapter(provider) {
  const model = (id) => ({ provider, id, name: id })
  return {
    providerInfo: () => ({ id: provider, name: 'smoke' }),
    providerRetryPolicy: () => undefined,
    listModels: async () => [],
    resolveModel: async (_provider, id) => model(id),
    prepareCall: async (_provider, id) => ({ model: model(id), stream: () => fakeStream() }),
    stream: () => fakeStream(),
  }
}

const dir = await mkdtemp(join(tmpdir(), 'dsh-openai-subscription-integration-'))
// The meter resolves its ledger and settings through DSH_HOME; pointing that at
// the temporary directory is what keeps this check away from a real install.
const previousHome = process.env.DSH_HOME
process.env.DSH_HOME = dir
try {
  const ctx = new Context()
  await ctx.plugin(LocalCredentialProvider, { path: join(dir, '.credentials.yaml'), watch: false })
  await ctx.plugin(LlmRuntime)

  // Bootstrap state must not load the runtime.
  const bootstrapResult = await activateSafely(ctx, { state: 'bootstrap', oauth: { clientId: 'test' } })
  if (bootstrapResult.loaded !== false) {
    throw new Error('bootstrap state unexpectedly loaded runtime')
  }
  if (ctx.llm.listProviders().some((entry) => entry.id === 'openai-subscription')) {
    throw new Error('bootstrap state unexpectedly registered provider')
  }

  // Active state must register the provider and configurable directory.
  const activeResult = await activateSafely(ctx, { state: 'active', oauth: { clientId: 'test-client' } })
  if (activeResult.loaded !== true) {
    throw new Error(`active runtime failed: ${JSON.stringify(activeResult)}`)
  }
  const providers = ctx.llm.listProviders()
  if (!providers.some((entry) => entry.id === 'openai-subscription')) {
    throw new Error('openai-subscription provider was not registered')
  }
  const directory = ctx.llm.listConfigurableProviders()
  if (!directory.some((entry) => entry.provider === 'openai-subscription')) {
    throw new Error('openai-subscription configurable directory entry was not registered')
  }

  // Drive one metered call through the real waterfall: the adapter reports a
  // million uncached input tokens, which the built-in snapshot prices at CNY 1.
  const adapterHandle = ctx.llm.registerAdapter(['deepseek-official'], fakeAdapter('deepseek-official'))
  try {
    for await (const _chunk of ctx.llm.stream({
      provider: 'deepseek-official',
      model: 'deepseek-flash',
      messages: [],
      sessionId: 'smoke-session',
    })) {
      // Drain: metering happens as the stream is consumed.
    }
  } finally {
    adapterHandle()
  }

  // The second metered vendor is a pi-ai route this plugin does not provide but
  // does account for: a GLM call must land as a token-only fact with no price
  // attached, because a coding plan has no per-token rate to charge.
  const glmHandle = ctx.llm.registerAdapter(['zai-coding-cn'], fakeAdapter('zai-coding-cn'))
  try {
    for await (const _chunk of ctx.llm.stream({
      provider: 'zai-coding-cn',
      model: 'glm-5.3',
      messages: [],
      sessionId: 'smoke-session',
    })) {
      // Drain: metering happens as the stream is consumed.
    }
  } finally {
    glmHandle()
  }

  // The third call runs on a provider this plugin has never heard of: a route
  // another plugin registered after the meter started. It must be counted from
  // its first call, with no price attached, because the registry is not what
  // decides which providers exist.
  const strangerHandle = ctx.llm.registerAdapter(['acme-llm'], fakeAdapter('acme-llm'))
  try {
    for await (const _chunk of ctx.llm.stream({
      provider: 'acme-llm',
      model: 'acme-large',
      messages: [],
      sessionId: 'smoke-session',
    })) {
      // Drain: metering happens as the stream is consumed.
    }
  } finally {
    strangerHandle()
  }

  const ledgerPath = join(dir, 'storages', 'openai-subscription-meter', 'usage.json')
  // The ledger debounces its write, so poll until the durable file holds every
  // fact rather than assuming a fixed delay.
  let ledger
  let lastError
  for (let attempt = 0; attempt < 60 && ledger === undefined; attempt += 1) {
    try {
      const parsed = JSON.parse(await readFile(ledgerPath, 'utf8'))
      if (Array.isArray(parsed.entries) && parsed.entries.length === 3) ledger = parsed
      else lastError = new Error(`ledger holds ${Array.isArray(parsed.entries) ? parsed.entries.length : '?'} entries`)
    } catch (error) {
      lastError = error
    }
    if (ledger === undefined) await new Promise((resolve) => { setTimeout(resolve, 100) })
  }
  if (ledger === undefined) {
    throw new Error(`meter ledger was not written at ${ledgerPath}: ${lastError?.message}`)
  }
  const entry = ledger.entries.find((candidate) => candidate.fact.provider === 'deepseek-official')
  const glmEntry = ledger.entries.find((candidate) => candidate.fact.provider === 'zai-coding-cn')
  const strangerEntry = ledger.entries.find((candidate) => candidate.fact.provider === 'acme-llm')
  if (entry === undefined || glmEntry === undefined || strangerEntry === undefined) {
    throw new Error(`metered facts lost a route: ${JSON.stringify(ledger.entries.map((candidate) => candidate.fact.provider))}`)
  }
  if (ledger.entries.some((candidate) => candidate.fact.sessionId !== 'smoke-session')) {
    throw new Error(`metered facts lost their session: ${JSON.stringify(ledger.entries.map((candidate) => candidate.fact.sessionId))}`)
  }
  if (entry.quote?.status !== 'priced') {
    throw new Error(`metered fact was not priced by the built-in snapshot: ${JSON.stringify(entry.quote)}`)
  }
  // The band depends on when this check runs — the meter prices a call by its
  // start instant — so the expectation follows the band the quote reports
  // instead of assuming one, which would fail every weekday peak window.
  const expectedMicros = entry.quote.band === 'peak' ? 2_000_000 : 1_000_000
  if (entry.quote.amountMicros !== expectedMicros) {
    throw new Error(`1M uncached deepseek-flash tokens in the ${entry.quote.band} band should cost ${expectedMicros} micros, got ${JSON.stringify(entry.quote.amountMicros)}`)
  }
  if (glmEntry.fact.model !== 'glm-5.3' || glmEntry.fact.usage.inputTokens !== 1_000_000) {
    throw new Error(`the GLM fact lost its buckets: ${JSON.stringify(glmEntry.fact)}`)
  }
  if (glmEntry.quote?.status !== 'unpriced' || glmEntry.quote.amountMicros !== undefined) {
    throw new Error(`a GLM call must be accounted for and never priced: ${JSON.stringify(glmEntry.quote)}`)
  }
  if (strangerEntry.fact.model !== 'acme-large' || strangerEntry.fact.usage.inputTokens !== 1_000_000) {
    throw new Error(`the discovered route lost its buckets: ${JSON.stringify(strangerEntry.fact)}`)
  }
  if (strangerEntry.quote?.status !== 'unpriced' || strangerEntry.quote.amountMicros !== undefined) {
    throw new Error(`a route with no price table must be counted without money: ${JSON.stringify(strangerEntry.quote)}`)
  }

  console.log(`OK: plugin root ${pluginRoot}`)
  console.log(`OK: bootstrap state stays inactive`)
  console.log(`OK: active state registers provider openai-subscription`)
  console.log(`OK: a real llm/stream call becomes a priced ledger fact (1M uncached input tokens = CNY ${(expectedMicros / 1_000_000).toFixed(2)} in the ${entry.quote.band} band)`)
  console.log(`OK: a GLM call on the pi-ai route lands as an unpriced token fact (${glmEntry.fact.usage.inputTokens} input tokens, reason ${glmEntry.quote.reason})`)
  console.log(`OK: a provider registered by nobody this plugin knows is metered too (acme-llm, ${strangerEntry.fact.usage.inputTokens} input tokens, reason ${strangerEntry.quote.reason})`)
} finally {
  if (previousHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = previousHome
  await rm(dir, { recursive: true, force: true })
}
