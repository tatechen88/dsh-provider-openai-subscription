/**
 * Runtime module for the OpenAI Subscription provider plugin.
 *
 * This module is only loaded after the bootstrap has verified activation.  It
 * wires the credential repository, token manager, OAuth attempt manager,
 * balance service, LLM provider adapter, and local HTTP routes through the
 * DSH context.  Every failure is contained: the bootstrap catches it and
 * leaves the plugin disabled rather than letting it break DSH startup.
 *
 * @module dsh-provider-openai-subscription/runtime
 */

import { PACKAGE_NAME, PROVIDER_ID, SETTINGS_NAMESPACE } from './constants.js'
import { readConflictReport } from './conflicts.js'
import { CredentialRepository } from './credentials/repository.js'
import { TokenManager } from './credentials/token-manager.js'
import { exchangeAuthorizationCode, refreshAccessToken } from './oauth/token-client.js'
import { extractAccountId, extractEmail } from './oauth/jwt.js'
import { OAuthAttemptManager } from './oauth/attempt-manager.js'
import { DeviceOAuthAttemptManager } from './oauth/device-attempt.js'
import { fetchBalance } from './balance/client.js'
import { BalanceService } from './balance/service.js'
import { OpenAISubscriptionAdapter } from './provider/adapter.js'
import { mountRoutes } from './web/routes.js'
import { inspectLegacy, backupLegacyCredential } from './migration/backup.js'
import { createUsageCollector } from './usage/collector.js'
import { UsageLedger } from './usage/ledger.js'
import { MeterSettingsStore } from './usage/settings-store.js'
import { UsageMeterService } from './usage/service.js'
import { LearnedPriceStore } from './usage/pricing-store.js'
import { METERED_PROVIDERS } from './usage/vendors.js'
import { dshHome, learnedPricePath, meterSettingsPath, usageLedgerPath } from './state.js'

/** How long the runtime waits for a DSH service to become available. */
export const SERVICE_WAIT_TIMEOUT_MS = 30_000

/** Poll cadence while waiting for a DSH service. */
export const SERVICE_WAIT_TICK_MS = 25

/**
 * Wait for one DSH service to be registered on the context.
 *
 * Activation can race the Loader: sibling rows (llm, credentials, webserver)
 * provide their services during their own activation, and this plugin has no
 * fiber-level inject to order itself after them.  The wait is bounded so a
 * missing service degrades the plugin instead of stalling DSH boot.
 *
 * @param {object} ctx - Cordis context.
 * @param {string} name - service name to look up via ctx.get(name).
 * @param {object} [options]
 * @param {number} [options.timeoutMs] - max wait before giving up.
 * @param {number} [options.tickMs] - poll cadence.
 * @param {() => number} [options.now]
 * @param {(ms: number) => Promise<void>} [options.sleep]
 * @returns {Promise<unknown>} the service once available, undefined on timeout.
 */
export async function waitForService(ctx, name, options = {}) {
  const { timeoutMs = SERVICE_WAIT_TIMEOUT_MS, tickMs = SERVICE_WAIT_TICK_MS, now = Date.now } = options
  // No service registry at all: nothing can ever register, so do not wait.
  if (ctx === null || typeof ctx !== 'object' || typeof ctx.get !== 'function') return undefined
  const sleep = options.sleep === undefined
    ? (ms) => new Promise((resolve) => setTimeout(resolve, ms))
    : options.sleep
  const deadline = now() + timeoutMs
  while (true) {
    const service = ctx.get(name)
    if (service !== undefined) return service
    const remaining = deadline - now()
    if (remaining <= 0) return undefined
    await sleep(Math.min(tickMs, remaining))
  }
}

/**
 * Apply the runtime feature set.
 *
 * @param {object} ctx - Cordis context.
 * @param {object} config - normalized plugin config.
 * @param {object} [options] - forwarded to the service waits (test seam).
 * @returns {Promise<{ok: boolean, reason?: string}>}
 */
export async function applyRuntime(ctx, config, options = {}) {
  const logger = ctx?.logger
  const credentials = await waitForService(ctx, 'credentials', options)
  const llm = await waitForService(ctx, 'llm', options)
  // The web server is optional, so it is probed rather than awaited: an absent
  // server must not stall activation for the whole wait budget when the routes
  // can simply mount whenever one appears (see the injection below).
  const webServer = typeof ctx?.get === 'function' ? ctx.get('webServer') : undefined

  const report = await readConflictReport(ctx)
  if (!report.ok) {
    const conflicts = [...report.providerConflicts, ...report.directoryConflicts, ...report.namespaceConflicts]
    const reason = report.missingServices.length > 0
      ? `missing DSH services: ${report.missingServices.join(', ')}`
      : `provider/namespace conflict: ${conflicts.join(', ')}`
    if (logger?.warn) logger.warn(`${PACKAGE_NAME}: runtime stays disabled (${reason})`)
    return { ok: false, reason }
  }

  if (credentials === undefined) {
    logger?.warn?.(`${PACKAGE_NAME}: runtime stays disabled (credentials service is unavailable)`)
    return { ok: false, reason: 'no-credentials' }
  }

  const repository = new CredentialRepository(credentials)
  const tokenManager = new TokenManager({
    repository,
    refreshFn: async (refreshToken, signal) => {
      const token = await refreshAccessToken({ clientId: config.oauth.clientId, refreshToken, fetchImpl: globalThis.fetch, signal })
      const accountId = extractAccountId(token.idToken, token.access)
      return {
        access: token.access,
        ...(token.refresh === undefined ? {} : { refresh: token.refresh }),
        expires: token.expires,
        ...(accountId === undefined ? {} : { accountId }),
        ...(extractEmail(token.idToken, token.access) === undefined ? {} : { email: extractEmail(token.idToken, token.access) }),
      }
    },
  })
  const exchange = async ({ clientId, code, redirectUri, codeVerifier }) => {
    return exchangeAuthorizationCode({ clientId, code, redirectUri, codeVerifier, fetchImpl: globalThis.fetch })
  }
  const attempts = new OAuthAttemptManager({ clientId: config.oauth.clientId, repository, exchange })
  const devices = new DeviceOAuthAttemptManager({ clientId: config.oauth.clientId, repository, exchange })
  const balance = new BalanceService({
    fetch: () => fetchBalance({ getAccess: () => tokenManager.getAccessSnapshot() }),
  })
  const migration = {
    status: async () => {
      const legacy = await inspectLegacy({ llm, credentials })
      return { ...legacy, recommendedProvider: PROVIDER_ID, balanceProvider: PROVIDER_ID }
    },
    backup: (password) => backupLegacyCredential({ credentials, password }),
  }

  const meter = await createMeter({ ctx, config, credentials, balance, logger, home: options.home })

  const adapter = llm?.registerAdapter === undefined ? undefined : new OpenAISubscriptionAdapter({
    getAccess: () => tokenManager.getAccessSnapshot(),
    defaultModel: config.provider?.defaultModel || '',
    reasoningEffort: config.provider?.reasoningEffort || '',
  })
  const listModels = adapter === undefined ? undefined : () => adapter.listModels(PROVIDER_ID)
  const invalidateModels = adapter === undefined ? undefined : () => adapter.invalidateCatalog()

  // Everything this activation owns, oldest registration first. Nothing is
  // handed back to Cordis until the whole set has registered, so a failure
  // part-way through must undo what already succeeded: an adapter, a directory
  // entry, or a few HTTP routes left behind would have no owner to release
  // them.
  const owned = []
  /**
   * Run every owned disposer in reverse registration order.
   *
   * Draining the list makes this safe to call twice: the first caller — either
   * the failed-setup rollback or the effect disposer — owns the teardown.
   * @returns {Promise<void>} settles once every async disposer has settled.
   */
  const release = async () => {
    const pending = []
    for (const dispose of owned.splice(0).reverse()) {
      try {
        const result = dispose()
        if (result !== null && typeof result === 'object' && typeof result.then === 'function') {
          pending.push(Promise.resolve(result))
        }
      } catch (error) {
        logger?.warn?.(`${PACKAGE_NAME}: a teardown step failed`, error)
      }
    }
    await Promise.allSettled(pending)
  }
  /**
   * Mount the browser-facing routes onto one web server.
   * @param {object} server - the resolved `webServer` service.
   * @returns {() => void} disposer releasing every route and the balance cache.
   */
  const mountWebRoutes = (server) => {
    const authorize = connectionTrust(ctx)
    const dispose = mountRoutes({ webServer: server }, {
      repository,
      attempts,
      devices,
      balance,
      listModels,
      invalidateModels,
      config,
      clientId: config.oauth.clientId,
      exchange,
      migration,
      meter,
      ...(authorize === undefined ? {} : { authorize }),
    })
    return () => {
      dispose()
      balance.clear()
    }
  }

  const register = () => {
    // The meter owns the ledger file, so it is registered first and therefore
    // torn down last — including on a rollback, where leaking an open ledger
    // would otherwise need a process restart to release.
    owned.push(() => meter.dispose())
    if (llm?.registerAdapter !== undefined && llm.registerConfigurableProviders !== undefined) {
      const adapterHandle = llm.registerAdapter([PROVIDER_ID], adapter)
      owned.push(() => adapterHandle())
      const directoryHandle = llm.registerConfigurableProviders([{
        provider: PROVIDER_ID,
        displayName: 'OpenAI (ChatGPT OAuth)',
        settingsNs: SETTINGS_NAMESPACE,
        settingsPath: [],
      }])
      owned.push(() => directoryHandle())
    }
    if (typeof llm?.registerModelDiscovery === 'function' && adapter !== undefined) {
      // DSH's Models page probes a provider through this seam. Answering from
      // the same authenticated catalog the model picker uses keeps one source
      // of truth instead of adding a second, drifting model list.
      owned.push(llm.registerModelDiscovery(SETTINGS_NAMESPACE, (_request, signal) => adapter.discoverModels(signal)))
    }
    if (webServer?.register !== undefined) {
      owned.push(mountWebRoutes(webServer))
    } else if (typeof ctx.inject === 'function') {
      // No web server yet. Injecting one keeps the routes tied to the server's
      // own lifetime instead of a single startup decision: they mount when a
      // server appears — including one that appears after this activation, or
      // replaces a failed one — and are released when it goes away.
      const routesFiber = ctx.inject(['webServer'], (scope) => {
        scope.effect(() => mountWebRoutes(scope.webServer), `${PACKAGE_NAME}: routes`)
      })
      owned.push(() => routesFiber.dispose())
    } else {
      logger?.warn?.(`${PACKAGE_NAME}: no web server and no injection available; HTTP routes are not mounted`)
    }
    // Metering rides the global model-call waterfall, so it is registered
    // through the same effect as every other contribution.
    if (ctx.on !== undefined) {
      owned.push(ctx.on('llm/stream', meter.collector, { global: true }))
    }
  }

  if (typeof ctx.effect !== 'function') {
    // Registrations are effects: a context without the effect API cannot own
    // what it registers, so this deployment is unsupported rather than
    // partially wired. The meter is already open by now, and nothing else will
    // ever own it, so it has to be closed here.
    await release()
    await meter.dispose().catch(() => {})
    return { ok: false, reason: 'no-effect-api' }
  }
  ctx.effect(() => {
    try {
      register()
    } catch (error) {
      // Nothing owns a partial registration: undo it before the failure
      // reaches the loader.
      void release().catch(() => {})
      throw error
    }
    return async () => {
      // Sequential and individually guarded: the ledger flush is the last step
      // and the only one that can lose data, so one failing surface must not
      // strand it. Returning the promise lets a caller that awaits the disposer
      // observe a finished flush instead of racing it.
      await release()
      await attempts.dispose().catch(() => {})
      await devices.dispose().catch(() => {})
    }
  }, `${PACKAGE_NAME}: provider, routes and state`)

  if (logger?.info) logger.info(`${PACKAGE_NAME}: runtime active for provider "${PROVIDER_ID}" namespace "${SETTINGS_NAMESPACE}"`)
  return { ok: true }
}

/**
 * DSH's own trust and authentication fence, when this deployment provides one.
 *
 * The Connection service first applies the Host fence that defeats DNS
 * rebinding and then authenticates the browser session cookie. That is strictly
 * stronger than comparing `Origin` with `Host`: the local comparison never
 * binds a request to a browser session and has no Host fence at all, so a
 * rebound page reaches these routes with a matching-looking Origin.
 *
 * @param {object} ctx - Cordis context.
 * @returns {((request: {headers: object}) => 401|403|undefined)|undefined}
 *   the fence, or undefined when no Connection service is mounted.
 */
export function connectionTrust(ctx) {
  let connection
  try {
    connection = typeof ctx?.get === 'function' ? ctx.get('connection') : undefined
  } catch {
    connection = undefined
  }
  if (connection === undefined || typeof connection.requestRejection !== 'function') return undefined
  return (request) => {
    try {
      const rejection = connection.requestRejection({ headers: request.headers })
      return rejection === 401 || rejection === 403 ? rejection : undefined
    } catch {
      // A fence that cannot answer must not open the route.
      return 403
    }
  }
}

/**
 * Resolve the DeepSeek API key for the meter's balance query.
 *
 * Only the key is taken from the DeepSeek configuration: the balance is read
 * from the official host regardless of where model calls are routed, so a
 * gateway deployment keeps its official balance and no key is ever sent to a
 * third-party endpoint.
 *
 * The key is re-resolved on every refresh, exactly like a model request, so a
 * rotated credential reaches the next query without a restart.
 * @param {object|undefined} ctx
 * @param {object|undefined} credentials
 * @returns {Promise<{apiKey: string|undefined}>}
 */
export async function resolveDeepSeekCredential(ctx, credentials) {
  let section
  try {
    const settings = typeof ctx?.get === 'function' ? ctx.get('settings') : undefined
    section = typeof settings?.get === 'function' ? settings.get('llm-deepseek') : undefined
  } catch {
    section = undefined
  }
  const envName = typeof section?.apiKeyEnv === 'string' && section.apiKeyEnv.length > 0 ? section.apiKeyEnv : 'DEEPSEEK_API_KEY'
  let apiKey
  try {
    const hit = credentials === undefined ? undefined : await credentials.resolve(envName)
    if (hit !== undefined && typeof hit.value === 'string' && hit.value.length > 0) apiKey = hit.value
  } catch {
    // A provider that cannot answer falls through to the process environment.
  }
  if (apiKey === undefined && typeof process.env[envName] === 'string') apiKey = process.env[envName]
  return { apiKey }
}

/**
 * Resolve the Zhipu API key for the meter's account reading.
 *
 * The pi-ai catalog authenticates its Z.AI routes from a named credential
 * reference, and that is the same store model calls use, so the meter reads it
 * through `ctx.credentials` rather than the process environment. Only the key is
 * taken: `zhipu-account.js` owns the station, which is what keeps the key on the
 * official host.
 *
 * A route's configured reference wins over the catalog default, exactly as the
 * DeepSeek reader prefers `llm-deepseek.apiKeyEnv`, and it is re-resolved on
 * every refresh so a rotated key reaches the next reading without a restart.
 *
 * @param {object|undefined} ctx
 * @param {object|undefined} credentials
 * @returns {Promise<{apiKey: string|undefined}>}
 */
export async function resolveZhipuCredential(ctx, credentials) {
  // The reference pi-ai's installed catalog names for `zai-coding-cn`.
  const fallbackName = 'ZAI_CODING_CN_API_KEY'
  let configured
  try {
    const settings = typeof ctx?.get === 'function' ? ctx.get('settings') : undefined
    const section = typeof settings?.get === 'function' ? settings.get('llm-pi-ai') : undefined
    configured = section?.providers?.['zai-coding-cn']?.apiKeyEnv
  } catch {
    configured = undefined
  }
  const envName = typeof configured === 'string' && configured.length > 0 ? configured : fallbackName
  let apiKey
  try {
    const hit = credentials === undefined ? undefined : await credentials.resolve(envName)
    if (hit !== undefined && typeof hit.value === 'string' && hit.value.length > 0) apiKey = hit.value
  } catch {
    // A credential store that cannot answer falls through to the environment.
  }
  if (apiKey === undefined && typeof process.env[envName] === 'string') apiKey = process.env[envName]
  return { apiKey }
}

/**
 * How long a discovered provider list is reused before asking DSH again.
 *
 * The lookup runs on every metered call, so it must not walk the registry each
 * time; it must also not be frozen for the process, or a provider registered
 * later would stay invisible.
 */
export const PROVIDER_LIST_TTL_MS = 5_000

/**
 * The routes this meter records, as a live question rather than a fixed list.
 *
 * The vendor registry says which routes this plugin can read an account for; it
 * must not decide which providers exist. DSH knows that, so a vendor added by
 * another plugin is metered for tokens from its first call. A route that never
 * registers is passed through untouched, which keeps an unknown id in a stray
 * stream from creating facts nobody asked for.
 * @param {object} ctx - Cordis context.
 * @param {object} [options]
 * @param {boolean} [options.auto] - false restores the registry list alone.
 * @param {() => number} [options.now]
 * @returns {{covers: (id: unknown) => boolean, known: () => string[]}}
 */
export function createMeterRoutes(ctx, { auto = true, now = Date.now } = {}) {
  let cached = { at: Number.NEGATIVE_INFINITY, ids: [] }
  const registered = () => {
    const at = now()
    if (at - cached.at < PROVIDER_LIST_TTL_MS) return cached.ids
    let ids = []
    try {
      // `ctx.llm` is refused on a plugin context that does not declare
      // `inject: ['llm']`. The throw would land in the catch below as "no
      // providers", which silently disabled auto-provider metering in every
      // real process while passing the composition smoke, whose root context
      // may read the property freely. The inject-free accessor is the one this
      // plugin is entitled to.
      const listed = ctx.get?.('llm')?.listProviders()
      if (Array.isArray(listed)) {
        ids = listed
          .map((entry) => (entry === null || entry === undefined ? undefined : entry.id))
          .filter((id) => typeof id === 'string' && id.length > 0)
      }
    } catch {
      // A context without the llm service has no providers to discover; the
      // registry's own routes are still metered.
      ids = []
    }
    cached = { at, ids }
    return ids
  }
  return {
    covers(id) {
      if (typeof id !== 'string' || id.length === 0) return false
      if (METERED_PROVIDERS.includes(id)) return true
      return auto && registered().includes(id)
    },
    known() {
      if (!auto) return [...METERED_PROVIDERS]
      const extra = registered().filter((id) => !METERED_PROVIDERS.includes(id))
      return [...METERED_PROVIDERS, ...extra]
    },
  }
}

/**
 * Assemble the usage meter: durable ledger, price book, settings file, and the
 * `llm/stream` listener that feeds them.
 *
 * A meter that cannot open its ledger stays disabled rather than failing the
 * plugin: a broken accounting file must never stop model calls.
 * @param {object} options
 * @param {object} options.ctx
 * @param {object} options.config - normalized plugin config.
 * @param {object|undefined} options.credentials
 * @param {object|undefined} options.balance - OpenAI subscription balance service.
 * @param {object|undefined} options.logger
 * @param {string} [options.home] - DSH home; injectable so tests never write the real one.
 * @returns {Promise<object>}
 */
export async function createMeter({ ctx, config, credentials, balance, logger, home = dshHome() }) {
  const base = config?.meter !== null && typeof config?.meter === 'object' ? config.meter : {}
  const settings = new MeterSettingsStore({ path: meterSettingsPath(home), base })
  try {
    await settings.open()
  } catch (error) {
    // Preferences are not worth a disabled provider: fall back to the
    // composition-level defaults and let the next save replace the file.
    logger?.warn?.(`${PACKAGE_NAME}: meter settings could not be read; using defaults`, error)
  }
  const resolved = settings.resolved()
  // Which routes this meter records: the registry's vendors plus every provider
  // DSH has registered. Built once so the collector and the view answer the same
  // question from the same cached list.
  const routes = createMeterRoutes(ctx, { auto: resolved.autoProviders !== false })
  // The learned price table is derived data: an unreadable file is reported once
  // and then ignored, and the built-in snapshot prices calls as it always did.
  const prices = new LearnedPriceStore({ path: learnedPricePath(home) })
  const priceState = await prices.open()
  if (priceState.reason !== undefined) {
    logger?.warn?.(`${PACKAGE_NAME}: learned price table was ignored (${priceState.reason})`)
  }

  const ledger = new UsageLedger({
    path: usageLedgerPath(home),
    timeZone: resolved.timeZone,
    retentionDays: resolved.retentionDays,
  })
  const passthrough = (_options, next) => next()
  let collector = passthrough
  try {
    await ledger.open()
  } catch (error) {
    logger?.error?.(`${PACKAGE_NAME}: usage ledger is unavailable; metering is disabled`, error)
    return {
      ledger,
      settings,
      service: undefined,
      collector: passthrough,
      openaiQuota: undefined,
      dispose: async () => {},
    }
  }

  const service = new UsageMeterService({
    ledger,
    // The raw layer: the service normalizes contract prices itself, while the
    // resolved view already states them in micro units.
    config: settings.raw(),
    readDeepSeekCredential: () => resolveDeepSeekCredential(ctx, credentials),
    // The pi-ai catalog authenticates its Z.AI routes from this reference, so the
    // meter reads the same account through the same store rather than looking at
    // the process environment.
    readZhipuCredential: () => resolveZhipuCredential(ctx, credentials),
    // What the browser is allowed to follow: the routes metered right now.
    listRoutes: () => routes.known(),
    // The vendor's own table, when this deployment reads one from its page.
    pricingStore: prices,
  })
  // Warm the readings once: the sidebar shows an account only once one has been
  // read, and leaving that to a manual refresh means an empty panel until
  // somebody presses it. A failure already lands in the reading's status.
  void service.refreshDeepSeekBalance().catch(() => {})
  void service.refreshZhipuAccount().catch(() => {})
  collector = createUsageCollector({
    record: (fact) => {
      const stored = service.recordUsage(fact)
      // Metering is best-effort, but a fact that never reaches the ledger must
      // not be silent: it is the only sign that a usage event no longer carries
      // what this plugin expects.
      if (stored.ok !== true) logger?.warn?.(`${PACKAGE_NAME}: usage fact was not recorded (${String(stored.reason)})`)
    },
    providers: (id) => routes.covers(id),
  })
  const openaiQuota = balance === undefined ? undefined : () => balance.get()

  return {
    ledger,
    settings,
    service,
    collector,
    openaiQuota,
    dispose: async () => {
      await ledger.close().catch((error) => {
        // The ledger is the user's accounting: a flush that fails means the
        // numbers they are looking at are not durable. Silence here would be
        // the only sign of it.
        logger?.warn?.(`${PACKAGE_NAME}: the usage ledger could not be flushed`, error)
      })
    },
  }
}
