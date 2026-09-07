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
        const dispose = mountRoutes({ webServer }, { repository, attempts, devices, balance, listModels, config, clientId: config.oauth.clientId, exchange, migration })
        disposers.push(() => {
          dispose()
          balance.clear()
        })
      }
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
      mountRoutes({ webServer }, { repository, attempts, devices, balance, listModels, config, clientId: config.oauth.clientId, exchange, migration })
    }
  }

  if (logger?.info) logger.info(`${PACKAGE_NAME}: runtime active for provider "${PROVIDER_ID}" namespace "${SETTINGS_NAMESPACE}"`)
  return { ok: true }
}
