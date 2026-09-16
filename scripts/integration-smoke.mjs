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
 *
 * Pass `--require-dsh` (or set DSH_REQUIRE_INTEGRATION=1) for a release check:
 * every SKIP becomes a failure, so a machine without DSH can never report a
 * green composition gate.
 */

import { createRequire } from 'node:module'
import { mkdtemp, readFile, rm, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { activateSafely } from '../src/bootstrap.js'
import { PROVIDER_ID, ROUTE_PREFIX, SETTINGS_NAMESPACE } from '../src/constants.js'

const here = dirname(fileURLToPath(import.meta.url))
const pluginRoot = join(here, '..')

/** Release mode: a skipped check is a failed check. */
const REQUIRE_DSH = process.argv.includes('--require-dsh') || process.env.DSH_REQUIRE_INTEGRATION === '1'

/**
 * Report a check that could not run.
 * @param {string} message - what was unavailable.
 * @returns {never}
 */
function skip(message) {
  if (REQUIRE_DSH) {
    console.error(`FAIL: ${message} (--require-dsh refuses to skip)`)
    process.exit(1)
  }
  console.log(`SKIP: ${message}`)
  process.exit(0)
}

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
  skip(`DSH packages not found; checked ${dshModules.checked.join(', ') || 'no configured locations'}`)
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
  skip(`DSH packages are incomplete under ${dshNodeModules} (${error instanceof Error ? error.message : String(error)})`)
}

/** One stream of chunks for the fake adapter below. */
function fakeStream() {
  return (async function* generate() {
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'hello' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'hello' } }
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

  // ── the DSH 0.1.6 stream grammar ───────────────────────────────────────
  // Mount the harness's own stream validator, prove it is live by feeding it a
  // deliberately illegal stream, then run this plugin's real adapter through
  // the same waterfall. Without the negative case the positive one would prove
  // nothing.
  let invariantActive = false
  try {
    const { InvariantRegistry } = require('@deepseek-ai/dsh-invariants')
    await ctx.plugin(InvariantRegistry)
    await ctx.plugin(require('@deepseek-ai/dsh-llm/invariant'))
    if (ctx.get('invariants') === undefined) throw new Error('the invariants service did not register')
    invariantActive = true
  } catch (error) {
    skip(`the DSH stream invariant could not be mounted (${error instanceof Error ? error.message : String(error)})`)
  }

  if (invariantActive) {
    const probeModel = (provider, id) => ({ provider, id, name: id })
    const illegalAdapter = {
      providerInfo: (provider) => ({ id: provider, name: 'grammar probe' }),
      providerRetryPolicy: () => undefined,
      listModels: async () => [],
      resolveModel: async (provider, id) => probeModel(provider, id),
      prepareCall: async (provider, id) => ({
        model: probeModel(provider, id),
        stream: () => illegalAdapter.stream(),
      }),
      stream: () => (async function* illegalStream() {
        // A delta outside an open block: exactly what the translator used to emit.
        yield { type: 'text-delta', index: 0, text: 'no block-start' }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })(),
    }
    const illegal = ctx.llm.registerAdapter(['grammar-probe'], illegalAdapter)
    let rejected = false
    try {
      for await (const _chunk of ctx.llm.stream({ provider: 'grammar-probe', model: 'm', messages: [] })) {
        // Drain.
      }
    } catch {
      rejected = true
    } finally {
      illegal()
    }
    if (!rejected) throw new Error('the DSH stream invariant did not reject a text delta outside an open block')
    console.log('OK: the DSH 0.1.6 stream invariant is live and rejects a delta outside an open block')
  }

  // The plugin's own adapter, driven through the real waterfall with a stubbed
  // upstream: its translated SSE must satisfy that same validator.
  const { OpenAISubscriptionAdapter } = await import('../src/provider/adapter.js')
  const sseBody = [
    { type: 'response.output_text.delta', output_index: 0, delta: 'Hi' },
    { type: 'response.output_item.added', output_index: 1, item: { id: 'fc_1', type: 'function_call', call_id: 'call_1', name: 'bash' } },
    { type: 'response.function_call_arguments.delta', item_id: 'fc_1', call_id: 'call_1', delta: '{"c' },
    { type: 'response.function_call_arguments.done', item_id: 'fc_1', call_id: 'call_1', name: 'bash', arguments: '{"c":1}' },
    { type: 'response.output_text.done', output_index: 0, text: 'Hi' },
    { type: 'response.completed', response: { usage: { input_tokens: 100, output_tokens: 7, input_tokens_details: { cached_tokens: 40 } } } },
  ].map((event) => `data: ${JSON.stringify(event)}\n\n`).join('')
  const providerAdapter = new OpenAISubscriptionAdapter({
    getAccess: async () => ({ accessToken: 'probe', accountId: 'probe' }),
    fetchImpl: async (url) => {
      if (String(url).includes('/models')) return new Response(JSON.stringify({ models: [] }), { status: 200 })
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(sseBody))
          controller.close()
        },
      })
      return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } })
    },
  })
  const adapterProbe = ctx.llm.registerAdapter(['openai-subscription-probe'], providerAdapter)
  let translated
  try {
    translated = []
    for await (const chunk of ctx.llm.stream({ provider: 'openai-subscription-probe', model: 'gpt-5', messages: [] })) {
      translated.push(chunk)
    }
  } finally {
    adapterProbe()
  }
  const firstChunk = translated[0]
  if (firstChunk?.type !== 'block-start' || firstChunk.blockType !== 'text') {
    throw new Error(`the adapter's first chunk must open a text block, got ${JSON.stringify(firstChunk)}`)
  }
  const usageChunk = translated.find((chunk) => chunk.type === 'usage')
  if (usageChunk === undefined || usageChunk.usage.inputTokens !== 60 || usageChunk.usage.cacheReadTokens !== 40) {
    throw new Error(`the adapter lost its usage split: ${JSON.stringify(usageChunk)}`)
  }
  const toolEnd = translated.find((chunk) => chunk.type === 'block-end' && chunk.block.type === 'tool-call')
  if (toolEnd === undefined || toolEnd.block.arguments !== '{"c":1}') {
    throw new Error(`the adapter lost its tool call: ${JSON.stringify(toolEnd)}`)
  }

  // ── the config schema ───────────────────────────────────────────────────
  // A malformed known field used to be coerced into a default and disappear.
  // DSH validates the plugin's Config before apply(), so this drives the real
  // Cordis plugin machinery rather than calling the schema directly.
  {
    const pluginModule = await import('../src/index.js')
    if (pluginModule.Config === undefined) throw new Error('the plugin module exports no Config schema')
    // The config the deployed profile actually composes must pass untouched.
    const deployed = {
      state: 'active',
      oauth: { clientId: 'app_EMoamEEZ73f0CkXaXp7hrann' },
      provider: { defaultModel: '', reasoningEffort: '' },
      meter: { refreshPublicPrices: true },
    }
    const schemaCtx = new Context()
    await schemaCtx.plugin(LocalCredentialProvider, { path: join(dir, 'schema.credentials.yaml'), watch: false })
    await schemaCtx.plugin(LlmRuntime)
    // An unknown extra key stays legal: forward compatibility is why the plugin
    // tolerates config it predates. Activation may still fail for its own
    // runtime reasons here; what must not happen is a *config* refusal.
    let deployedFailure
    try {
      await schemaCtx.plugin(pluginModule, { ...deployed, somethingNewer: { nested: true } })
    } catch (error) {
      deployedFailure = error
    }
    if (deployedFailure !== undefined && /invalid config/.test(String(deployedFailure.message))) {
      throw new Error(`the deployed config shape was refused by the schema: ${String(deployedFailure.message)}`)
    }

    let refused
    try {
      await schemaCtx.plugin(pluginModule, { state: 5, oauth: { clientId: 'x' } })
    } catch (error) {
      refused = error
    }
    if (refused === undefined) throw new Error('Cordis accepted a config the schema should have refused')
    if (!/invalid config/.test(String(refused.message))) {
      throw new Error(`the schema failure was not reported as a config problem: ${String(refused.message)}`)
    }
    if (!/state must be one of/.test(String(refused.message))) {
      throw new Error(`the schema failure does not name the offending field: ${String(refused.message)}`)
    }
    console.log('OK: Cordis refuses a malformed config and names the field before apply() runs')
  }

  // ── provider request attribution ────────────────────────────────────────
  // DSH 0.1.6 requires every provider request to carry the harness
  // `attributionHeaders()`. A `link:`-installed checkout cannot reach that
  // package by walking up from its own path, so this asserts the resolution
  // actually finds it in a real install rather than silently falling back.
  {
    const { resolveAttributionHeaders, FALLBACK_USER_AGENT } = await import('../src/provider/attribution.js')
    // This smoke points DSH_HOME at a throwaway home for the meter's sake; the
    // attribution anchors describe the *deployment*, so the real home has to be
    // in place while they resolve.
    const scratchHome = process.env.DSH_HOME
    if (previousHome !== undefined) process.env.DSH_HOME = previousHome
    let headers
    try {
      headers = await resolveAttributionHeaders()
    } finally {
      if (previousHome !== undefined) process.env.DSH_HOME = scratchHome
    }
    const agent = headers['user-agent']
    if (typeof agent !== 'string' || agent.length === 0) {
      throw new Error(`the attribution headers carry no user-agent: ${JSON.stringify(headers)}`)
    }
    if (agent === FALLBACK_USER_AGENT) {
      throw new Error(`the harness attribution helper was not reached from ${dshNodeModules}; got the fallback ${agent}`)
    }
    if (!agent.startsWith('deepseek-harness/')) {
      throw new Error(`the harness helper produced an unexpected user-agent: ${agent}`)
    }
    console.log(`OK: provider requests carry the harness attribution helper (${agent})`)
  }

  // ── the model-discovery seam ────────────────────────────────────────────
  // DSH's Models page probes a provider through this registration. Reaching it
  // through the real service is what proves the namespace wiring; this
  // composition has no signed-in account, so the honest answer is the
  // credential reason rather than an empty list a surface would read as
  // "this provider has no models".
  {
    let refused
    try {
      await ctx.llm.discoverModels(SETTINGS_NAMESPACE, { provider: PROVIDER_ID })
    } catch (error) {
      refused = error
    }
    if (refused === undefined) throw new Error('the model discovery answered without an authenticated account')
    if (!/not signed in/i.test(String(refused.message))) {
      throw new Error(`the model discovery refused for an unexpected reason: ${String(refused.message)}`)
    }
    let unknownNamespace
    try {
      await ctx.llm.discoverModels('llm-not-this-plugin', { provider: PROVIDER_ID })
    } catch (error) {
      unknownNamespace = error
    }
    if (unknownNamespace === undefined) throw new Error('an unregistered namespace was served by this plugin')
    console.log(`OK: the model discovery is reachable through the real llm service (${String(refused.message)})`)
  }

  // ── route lifetime follows the web server ──────────────────────────────
  // The routes used to be mounted once at activation, after waiting up to 30s
  // for the optional service. They are now tied to the web server's own
  // lifetime, so this drives the real Cordis injection: activate with no web
  // server, then provide one and watch the routes arrive.
  {
    const lateHome = join(dir, 'late-web-server')
    const previousLateHome = process.env.DSH_HOME
    process.env.DSH_HOME = lateHome
    try {
      const routeCtx = new Context()
      await routeCtx.plugin(LocalCredentialProvider, { path: join(lateHome, '.credentials.yaml'), watch: false })
      await routeCtx.plugin(LlmRuntime)

      const startedAt = Date.now()
      const late = await activateSafely(routeCtx, { state: 'active', oauth: { clientId: 'late-web-server' } })
      const elapsed = Date.now() - startedAt
      if (late.loaded !== true) {
        throw new Error(`activation without a web server failed: ${JSON.stringify(late)}`)
      }
      if (elapsed > 5_000) {
        throw new Error(`an absent optional web server stalled activation for ${elapsed}ms`)
      }

      const server = {
        routes: new Map(),
        register(route) {
          if (this.routes.has(route.path)) throw new Error(`webserver: duplicate exact route "${route.path}"`)
          this.routes.set(route.path, route)
          return () => this.routes.delete(route.path)
        },
      }
      await routeCtx.plugin({
        name: 'smoke-web-server',
        apply: (pluginCtx) => { pluginCtx.provide('webServer', server) },
      })

      for (let attempt = 0; attempt < 100 && server.routes.size === 0; attempt += 1) {
        await new Promise((resolve) => { setTimeout(resolve, 20) })
      }
      if (server.routes.size === 0) {
        throw new Error('the plugin routes never mounted after a web server appeared')
      }
      if (!server.routes.has(`${ROUTE_PREFIX}/status`)) {
        throw new Error(`the mounted route set is missing the status route: ${[...server.routes.keys()].join(', ')}`)
      }
      console.log(`OK: routes mount onto a web server that appears after activation (${server.routes.size} routes, after ${String(elapsed)}ms)`)
    } finally {
      if (previousLateHome === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previousLateHome
    }
  }

  console.log(`OK: plugin root ${pluginRoot}`)
  console.log(`OK: bootstrap state stays inactive`)
  console.log(`OK: active state registers provider openai-subscription`)
  console.log(`OK: a real llm/stream call becomes a priced ledger fact (1M uncached input tokens = CNY ${(expectedMicros / 1_000_000).toFixed(2)} in the ${entry.quote.band} band)`)
  console.log(`OK: a GLM call on the pi-ai route lands as an unpriced token fact (${glmEntry.fact.usage.inputTokens} input tokens, reason ${glmEntry.quote.reason})`)
  console.log(`OK: a provider registered by nobody this plugin knows is metered too (acme-llm, ${strangerEntry.fact.usage.inputTokens} input tokens, reason ${strangerEntry.quote.reason})`)
  console.log(`OK: the adapter's own SSE translation passes the real DSH stream validator (${translated.length} chunks${invariantActive ? ', invariant active' : ', invariant unavailable'})`)
} finally {
  if (previousHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = previousHome
  await rm(dir, { recursive: true, force: true })
}
