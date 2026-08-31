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

/**
 * Apply the runtime feature set.
 *
 * @param {object} ctx - Cordis context.
 * @param {object} config - normalized plugin config.
 * @returns {Promise<{ok: boolean, reason?: string}>}
 */
export async function applyRuntime(ctx, config) {
  const report = await readConflictReport(ctx)
  if (!report.ok) {
    const logger = ctx?.logger
    const reason = report.missingServices.length > 0
      ? `missing DSH services: ${report.missingServices.join(', ')}`
      : `provider/namespace conflict: ${[...report.providerConflicts, ...report.namespaceConflicts].join(', ')}`
    if (logger?.warn) logger.warn(`${PACKAGE_NAME}: runtime stays disabled (${reason})`)
    return { ok: false, reason }
  }

  const credentials = ctx.get?.('credentials')
  if (credentials === undefined) {
    ctx?.logger?.warn?.(`${PACKAGE_NAME}: runtime stays disabled (credentials service is unavailable)`)
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
      const legacy = await inspectLegacy({ llm: ctx.get?.('llm'), credentials })
      return { ...legacy, recommendedProvider: PROVIDER_ID, balanceProvider: PROVIDER_ID }
    },
    backup: (password) => backupLegacyCredential({ credentials, password }),
  }

  const llm = ctx.get?.('llm')
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
      const webServer = ctx.get?.('webServer')
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
    const webServer = ctx.get?.('webServer')
    if (webServer?.register !== undefined) {
      mountRoutes({ webServer }, { repository, attempts, devices, balance, listModels, config, clientId: config.oauth.clientId, exchange, migration })
    }
  }

  const logger = ctx?.logger
  if (logger?.info) logger.info(`${PACKAGE_NAME}: runtime active for provider "${PROVIDER_ID}" namespace "${SETTINGS_NAMESPACE}"`)
  return { ok: true }
}
