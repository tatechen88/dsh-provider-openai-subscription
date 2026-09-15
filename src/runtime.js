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
import { createUsageLedger } from './usage/ledger.js'
import { MeterSettingsStore } from './usage/settings-store.js'
import { UsageMeterService } from './usage/service.js'
import { dshHome, pluginStateDir } from './state.js'
import { join } from 'node:path'

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
  const webServer = await waitForService(ctx, 'webServer', options)

  const report = await readConflictReport(ctx)
  if (!report.ok) {
    const reason = report.missingServices.length > 0
      ? `missing DSH services: ${report.missingServices.join(', ')}`
      : `provider/namespace conflict: ${[...report.providerConflicts, ...report.namespaceConflicts].join(', ')}`
    if (logger?.warn) logger.warn(`${PACKAGE_NAME}: runtime stays disabled (${reason})`)
    return { ok: false, reason }
  }

  if (credentials === undefined) {
    logger?.warn?.(`${PACKAGE_NAME}: runtime stays disabled (credentials service is unavailable)`)
    return { ok: false, reason: 'no-credentials' }
  }
  if (webServer === undefined) {
    logger?.warn?.(`${PACKAGE_NAME}: webServer service is unavailable; HTTP routes are not mounted`)
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

  if (typeof ctx.effect === 'function') {
    ctx.effect(() => {
      const disposers = []
      if (llm?.registerAdapter !== undefined && llm.registerConfigurableProviders !== undefined) {
        const adapterHandle = llm.registerAdapter([PROVIDER_ID], adapter)
        const directoryHandle = llm.registerConfigurableProviders([{
          provider: PROVIDER_ID,
          displayName: 'OpenAI (ChatGPT OAuth)',
          settingsNs: SETTINGS_NAMESPACE,
          settingsPath: [],
        }])
        disposers.push(() => { adapterHandle(); directoryHandle() })
      }
      if (webServer?.register !== undefined) {
        const dispose = mountRoutes({ webServer }, { repository, attempts, devices, balance, listModels, config, clientId: config.oauth.clientId, exchange, migration, meter })
        disposers.push(() => {
          dispose()
          balance.clear()
        })
      }
      // Metering rides the global model-call waterfall, so it is registered
      // through the same effect as every other contribution.
      if (ctx.on !== undefined) {
        disposers.push(ctx.on('llm/stream', meter.collector, { global: true }))
      }
      disposers.push(() => { void meter.dispose() })
      return () => {
        for (const dispose of disposers) dispose()
        void attempts.dispose()
        void devices.dispose()
      }
    }, `${PACKAGE_NAME}: provider, routes and state`)
  } else {
    // No Cordis effect API: mount what we can without disposal tracking. This
    // fallback is only for unusual embedded contexts; DSH always has ctx.effect.
    if (llm?.registerAdapter !== undefined && llm.registerConfigurableProviders !== undefined) {
      llm.registerAdapter([PROVIDER_ID], adapter)
      llm.registerConfigurableProviders([{
        provider: PROVIDER_ID,
        displayName: 'OpenAI (ChatGPT OAuth)',
        settingsNs: SETTINGS_NAMESPACE,
        settingsPath: [],
      }])
    }
    if (webServer?.register !== undefined) {
      mountRoutes({ webServer }, { repository, attempts, devices, balance, listModels, config, clientId: config.oauth.clientId, exchange, migration, meter })
    }
  }

  if (logger?.info) logger.info(`${PACKAGE_NAME}: runtime active for provider "${PROVIDER_ID}" namespace "${SETTINGS_NAMESPACE}"`)
  return { ok: true }
}

/** Ledger path under the DSH home. */
export function usageLedgerPath(home = dshHome()) {
  return join(home, 'storages', 'openai-subscription-meter', 'usage.json')
}

/** Meter settings path under the DSH home. */
export function meterSettingsPath(home = dshHome()) {
  return join(home, 'plugin-state', 'openai-subscription-meter.json')
}

/**
 * Resolve the DeepSeek API key and base URL for the meter.
 *
 * The key is re-resolved on every refresh, exactly like a model request, so a
 * rotated credential reaches the next query without a restart.
 * @param {object|undefined} ctx
 * @param {object|undefined} credentials
 * @returns {Promise<{baseURL: string|undefined, apiKey: string|undefined}>}
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
  const baseURL = typeof section?.baseURL === 'string' && section.baseURL.length > 0 ? section.baseURL : undefined
  let apiKey
  try {
    const hit = credentials === undefined ? undefined : await credentials.resolve(envName)
    if (hit !== undefined && typeof hit.value === 'string' && hit.value.length > 0) apiKey = hit.value
  } catch {
    // A provider that cannot answer falls through to the process environment.
  }
  if (apiKey === undefined && typeof process.env[envName] === 'string') apiKey = process.env[envName]
  return { baseURL, apiKey }
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
  await settings.open()
  const resolved = settings.resolved()

  const ledger = createUsageLedger({ path: usageLedgerPath(home), timeZone: resolved.timeZone })
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
    config: resolved,
    readDeepSeekCredential: () => resolveDeepSeekCredential(ctx, credentials),
  })
  collector = createUsageCollector({ record: (fact) => { service.recordUsage(fact) } })
  const openaiQuota = balance === undefined ? undefined : () => balance.get()

  return {
    ledger,
    settings,
    service,
    collector,
    openaiQuota,
    dispose: async () => {
      await ledger.close().catch(() => {})
    },
  }
}
