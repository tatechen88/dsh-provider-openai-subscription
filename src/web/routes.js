/**
 * Same-origin local HTTP API for the OpenAI Subscription plugin.
 *
 * The browser never calls auth.openai.com or chatgpt.com directly.  All
 * responses are redacted DTOs; tokens never leave the Host process.
 *
 * @module dsh-provider-openai-subscription/web/routes
 */

import { ROUTE_PREFIX } from '../constants.js'
import { CredentialSchemaError } from '../credentials/schema.js'
import { BalanceClientError } from '../balance/client.js'
import { PROVIDER_ID } from '../constants.js'

/** Maximum accepted JSON body size for small mutation routes. */
export const MAX_BODY_BYTES = 4096

/**
 * Byte cap for the settings route.
 *
 * It carries the whole configuration, including every contractual model entry,
 * so the small-mutation cap rejects a legitimate agreement list — four models
 * over ten bands already exceed 4 KiB.
 */
export const SETTINGS_BODY_BYTES = 65_536

/**
 * Write a JSON response with no-store caching.
 * @param {import('node:http').ServerResponse} response
 * @param {number} status
 * @param {unknown} payload
 */
export function sendJson(response, status, payload) {
  response.writeHead(status, {
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
    'x-content-type-options': 'nosniff',
  })
  response.end(JSON.stringify(payload))
}

/**
 * True when the request Origin matches its Host.
 * @param {import('node:http').IncomingMessage} request
 * @returns {boolean}
 */
export function sameOrigin(request) {
  const origin = request.headers.origin
  const host = request.headers.host
  if (host === undefined) return false
  if (origin !== undefined) {
    try {
      return new URL(origin).host === host
    } catch {
      return false
    }
  }
  if (request.headers['sec-fetch-site'] === 'same-origin') return true
  const referer = request.headers.referer
  if (referer !== undefined) {
    try {
      return new URL(referer).host === host
    } catch {
      return false
    }
  }
  return false
}

/**
 * Read a bounded JSON request body.
 * @param {import('node:http').IncomingMessage} request
 * @param {number} [limit] - byte cap; the small-mutation default suits every
 *   route except settings, which carries the whole configuration.
 * @returns {Promise<Record<string, unknown>>}
 */
export async function readJsonBody(request, limit = MAX_BODY_BYTES) {
  const chunks = []
  let total = 0
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
    total += bytes.byteLength
    if (total > limit) {
      const error = new Error('request body too large')
      error.code = 'body-too-large'
      throw error
    }
    chunks.push(bytes)
  }
  if (total === 0) throw new Error('request body is empty')
  let text
  try {
    text = new TextDecoder('utf8', { fatal: true }).decode(Buffer.concat(chunks))
  } catch {
    throw new Error('request body is not UTF-8')
  }
  let value
  try {
    value = JSON.parse(text)
  } catch {
    throw new Error('request body is not JSON')
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('request body must be an object')
  }
  return value
}

/**
 * Mount all plugin routes.
 * @param {object} host
 * @param {object} host.webServer
 * @param {(route: object) => () => void} host.webServer.register
 * @param {object} deps
 * @param {import('../credentials/repository.js').CredentialRepository} deps.repository
 * @param {import('../oauth/attempt-manager.js').OAuthAttemptManager} deps.attempts
 * @param {import('../oauth/device-attempt.js').DeviceOAuthAttemptManager} [deps.devices]
 * @param {import('../balance/service.js').BalanceService} deps.balance
 * @param {() => Promise<Array<{id: string, name?: string}>>} [deps.listModels]
 * @param {{provider?: {defaultModel?: string, reasoningEffort?: string}}} [deps.config]
 * @param {(clientId: string) => Promise<{access: string, refresh?: string, expires: number, idToken?: string}>} deps.exchange
 * @param {string} deps.clientId
 * @param {object} [deps.migration]
 * @param {() => Promise<object>} [deps.migration.status]
 * @param {(password: string) => Promise<object>} [deps.migration.backup]
 * @param {object} [deps.meter]
 * @param {import('../usage/service.js').UsageMeterService} deps.meter.service
 * @param {import('../usage/settings-store.js').MeterSettingsStore} [deps.meter.settings]
 * @param {() => Promise<object>} [deps.meter.openaiQuota] - current subscription quota snapshot.
 * @returns {() => void}
 */
export function mountRoutes(host, deps) {
  const disposers = []

  const route = (method, path, handler) => {
    const methods = Array.isArray(method) ? method : [method]
    const allow = methods.join(', ')
    disposers.push(host.webServer.register({
      kind: 'exact',
      path: `${ROUTE_PREFIX}${path}`,
      handler: async (request, response) => {
        // One path carries one registration: the web server matches exact
        // paths, so a second registration for the same path would shadow or
        // collide with the first. Methods are dispatched here instead.
        if (!methods.includes(request.method)) {
          response.writeHead(405, { allow })
          response.end()
          return
        }
        if (!sameOrigin(request)) {
          sendJson(response, 403, { ok: false, error: 'untrusted origin' })
          return
        }
        try {
          await handler(request, response)
        } catch (error) {
          const code = /** @type {{code?: string}} */ (error).code
          sendJson(response, code === 'body-too-large' ? 413 : 400, { ok: false, error: safeError(error) })
        }
      },
    }))
  }

  route('GET', '/status', async (_request, response) => {
    const status = await deps.repository.status()
    const provider = deps.config?.provider
    const migration = deps.migration?.status === undefined ? undefined : await deps.migration.status()
    sendJson(response, 200, { ok: true, data: {
      ...status,
      ...(provider === undefined ? {} : { provider: { defaultModel: provider.defaultModel || '', reasoningEffort: provider.reasoningEffort || '' } }),
      ...(migration === undefined ? {} : { migration }),
    } })
  })

  route('POST', '/oauth/start', async (_request, response) => {
    const started = await deps.attempts.create({ clientId: deps.clientId, repository: deps.repository, exchange: deps.exchange })
    sendJson(response, 200, { ok: true, data: { attemptId: started.attemptId, url: started.url, redirectUri: started.redirectUri } })
  })

  route('GET', '/oauth/attempt', async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost')
    const attemptId = url.searchParams.get('attemptId') ?? ''
    const attempt = deps.attempts.get(attemptId)
    if (attempt === undefined) {
      sendJson(response, 404, { ok: false, error: 'attempt not found' })
      return
    }
    sendJson(response, 200, { ok: true, data: attempt.toJSON() })
  })

  route('POST', '/oauth/code', async (request, response) => {
    const body = await readJsonBody(request)
    const attemptId = typeof body.attemptId === 'string' ? body.attemptId : ''
    const input = typeof body.input === 'string' ? body.input : ''
    const attempt = deps.attempts.get(attemptId)
    if (attempt === undefined) {
      sendJson(response, 404, { ok: false, error: 'attempt not found' })
      return
    }
    const result = attempt.submitManualCode(input)
    if (!result.ok) {
      sendJson(response, 400, { ok: false, error: result.error })
      return
    }
    sendJson(response, 200, { ok: true })
  })

  route('POST', '/oauth/cancel', async (request, response) => {
    const body = await readJsonBody(request)
    const attemptId = typeof body.attemptId === 'string' ? body.attemptId : ''
    const attempt = deps.attempts.get(attemptId)
    if (attempt !== undefined) attempt.cancel()
    sendJson(response, 200, { ok: true })
  })

  if (deps.devices !== undefined) {
    route('POST', '/oauth/device/start', async (_request, response) => {
      const started = await deps.devices.create({ clientId: deps.clientId, repository: deps.repository, exchange: deps.exchange })
      sendJson(response, 200, { ok: true, data: started })
    })

    route('GET', '/oauth/device/attempt', async (request, response) => {
      const url = new URL(request.url ?? '/', 'http://localhost')
      const attemptId = url.searchParams.get('attemptId') ?? ''
      const attempt = deps.devices.get(attemptId)
      if (attempt === undefined) {
        sendJson(response, 404, { ok: false, error: 'device attempt not found' })
        return
      }
      sendJson(response, 200, { ok: true, data: attempt.toJSON() })
    })

    route('POST', '/oauth/device/cancel', async (request, response) => {
      const body = await readJsonBody(request)
      const attemptId = typeof body.attemptId === 'string' ? body.attemptId : ''
      const attempt = deps.devices.get(attemptId)
      if (attempt !== undefined) attempt.cancel()
      sendJson(response, 200, { ok: true })
    })
  }

  route('POST', '/logout', async (_request, response) => {
    await deps.repository.delete()
    deps.balance.clear()
    sendJson(response, 200, { ok: true })
  })

  const inactiveBalance = (response) => sendJson(response, 200, { ok: true, data: { available: false, reason: 'inactive-provider' } })
  route('GET', '/balance', async (request, response) => {
    const provider = new URL(request.url ?? '/', 'http://localhost').searchParams.get('provider')
    if (provider !== PROVIDER_ID) return inactiveBalance(response)
    const snapshot = await deps.balance.get()
    sendJson(response, 200, { ok: true, data: snapshot })
  })

  route('POST', '/balance/refresh', async (request, response) => {
    const body = await readJsonBody(request)
    if (body.provider !== PROVIDER_ID) return inactiveBalance(response)
    const snapshot = await deps.balance.get(true)
    sendJson(response, 200, { ok: true, data: snapshot })
  })

  if (deps.migration?.backup !== undefined) {
    route('POST', '/migration/backup', async (request, response) => {
      const body = await readJsonBody(request)
      const password = typeof body.password === 'string' ? body.password : ''
      if (password.length < 12) {
        sendJson(response, 400, { ok: false, error: 'backup password must contain at least 12 characters' })
        return
      }
      const result = await deps.migration.backup(password)
      sendJson(response, 200, { ok: true, data: result })
    })
  }

  if (deps.listModels !== undefined) {
    route('GET', '/models', async (_request, response) => {
      const models = await deps.listModels()
      sendJson(response, 200, { ok: true, data: models })
    })

    route('POST', '/models/refresh', async (_request, response) => {
      // A refresh that answers with the cached catalogue is not a refresh.
      if (deps.invalidateModels !== undefined) deps.invalidateModels()
      const models = await deps.listModels()
      sendJson(response, 200, { ok: true, data: models })
    })
  }

  if (deps.meter !== undefined) {
    const { service, settings, openaiQuota } = deps.meter

    route('GET', '/meter/usage', async (request, response) => {
      const quota = openaiQuota === undefined ? undefined : await openaiQuota().catch(() => undefined)
      // A meter whose ledger could not be opened stays installed but reports
      // itself unavailable: the client hides the usage surfaces instead of
      // showing a request failure it cannot act on. The subscription quota is
      // independent of the ledger and keeps working.
      if (service === undefined) {
        sendJson(response, 200, {
          ok: true,
          data: {
            status: 'unavailable',
            deepseek: { status: 'off', infos: [], message: '' },
            zhipu: { status: 'off', packages: [], message: '' },
            ...(quota === undefined ? {} : { openaiQuota: quota }),
          },
        })
        return
      }
      const query = new URL(request.url ?? '/', 'http://localhost').searchParams
      const sessionId = query.get('sessionId')
      const provider = query.get('provider')
      sendJson(response, 200, {
        ok: true,
        data: {
          ...service.view({
            ...(sessionId === null || sessionId.length === 0 ? {} : { sessionId }),
            // Which route this read is about, so only that vendor's account is
            // asked for a fresh reading.
            ...(provider === null || provider.length === 0 ? {} : { provider }),
          }),
          ...(quota === undefined ? {} : { openaiQuota: quota }),
        },
      })
    })

    route('POST', '/meter/deepseek/refresh', async (_request, response) => {
      if (service === undefined) {
        sendJson(response, 200, { ok: false, error: 'usage meter is unavailable', data: { status: 'off', infos: [], message: '' } })
        return
      }
      const balance = await service.refreshDeepSeekBalance({ force: true })
      sendJson(response, 200, { ok: true, data: service.view().deepseek, status: balance.status })
    })

    route('POST', '/meter/zhipu/refresh', async (_request, response) => {
      if (service === undefined) {
        sendJson(response, 200, { ok: false, error: 'usage meter is unavailable', data: { status: 'off', packages: [], message: '' } })
        return
      }
      const reading = await service.refreshZhipuAccount({ force: true })
      sendJson(response, 200, { ok: true, data: service.view().zhipu, status: reading.status })
    })

    route('POST', '/meter/prices/refresh', async (_request, response) => {
      if (service === undefined) {
        sendJson(response, 200, { ok: false, error: 'usage meter is unavailable', data: { status: 'off' } })
        return
      }
      const result = await service.refreshPublicPrices({ force: true })
      sendJson(response, 200, { ok: true, data: result, status: result.status })
    })

    if (settings !== undefined) {
      route(['GET', 'PATCH'], '/meter/settings', async (request, response) => {
        if (request.method === 'GET') {
          // The editable view, not the resolved one: contract prices have to
          // reach the editor in the units the user wrote them in.
          sendJson(response, 200, { ok: true, data: { revision: settings.revision, config: settings.editable() } })
          return
        }
        const body = await readJsonBody(request, SETTINGS_BODY_BYTES)
        // The revision is the only protection against two tabs overwriting each
        // other, so a missing or mistyped one is refused instead of being read
        // as "replace whatever is stored".
        if (!Number.isSafeInteger(body.expectedRevision)) {
          sendJson(response, 400, { ok: false, error: 'expectedRevision must be a safe integer' })
          return
        }
        const patch = body.patch !== null && typeof body.patch === 'object' && !Array.isArray(body.patch) ? body.patch : undefined
        if (patch === undefined) {
          sendJson(response, 400, { ok: false, error: 'patch must be an object' })
          return
        }
        try {
          const result = await settings.update(patch, body.expectedRevision)
          // A degraded meter has no service to reconfigure; the settings still
          // persist so the next start picks them up. The service takes the raw
          // layer, because normalizing it is the service's own step.
          service?.updateConfig?.(result.raw)
          sendJson(response, 200, { ok: true, data: { revision: result.revision, config: settings.editable() } })
        } catch (error) {
          const failure = /** @type {{code?: string, actualRevision?: number}} */ (error)
          if (failure.code === 'settings-conflict') {
            // Returning the current revision lets the caller retry without a
            // second round trip; otherwise it keeps sending the stale one.
            sendJson(response, 409, { ok: false, error: safeError(error), actualRevision: failure.actualRevision })
            return
          }
          throw error
        }
      })
    }
  }

  return () => {
    for (const dispose of disposers) dispose()
  }
}

/**
 * Convert an unknown error into a safe short message.
 * @param {unknown} error
 * @returns {string}
 */
export function safeError(error) {
  if (error instanceof CredentialSchemaError || error instanceof BalanceClientError) return error.message
  if (error instanceof Error) return error.message
  return String(error)
}
