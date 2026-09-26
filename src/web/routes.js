/**
 * The one HTTP route this plugin still serves.
 *
 * This module used to mount twenty-two routes: the whole API of a browser half
 * that drove sign-in, read the balance, listed models, edited meter settings and
 * ran the legacy migration. That half is gone, and with it every caller those
 * routes had. What is left is for an operator: one read-only status endpoint,
 * reachable with `curl` against a running harness, behind the deployment's own
 * trust fence.
 *
 * The OAuth redirect is deliberately not here. The loopback attempt listens on
 * its own port (`127.0.0.1:1455` by default) for exactly as long as one sign-in
 * takes, so nothing about the callback depends on a web server being mounted,
 * and no long-lived route stands open for it.
 *
 * @module dsh-provider-openai-subscription/web/routes
 */

import { ROUTE_PREFIX } from '../constants.js'

/**
 * Write one JSON response.
 * @param {import('node:http').ServerResponse} response
 * @param {number} status
 * @param {unknown} payload
 * @returns {void}
 */
export function sendJson(response, status, payload) {
  const body = JSON.stringify(payload)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  })
  response.end(body)
}

/**
 * Whether one request comes from the harness's own page.
 *
 * The fallback fence for callers that supply none: a browser sends `Origin` on
 * cross-origin requests, so a matching one is the page itself, and a missing one
 * is a same-origin or non-browser caller.
 *
 * @param {{headers: Record<string, string|string[]|undefined>}} request
 * @returns {boolean}
 */
export function sameOrigin(request) {
  const origin = request.headers.origin
  if (origin === undefined || origin === '') return true
  const host = request.headers.host
  if (typeof origin !== 'string' || typeof host !== 'string') return false
  return origin === `http://${host}` || origin === `https://${host}`
}

/**
 * Describe a failure without leaking internals.
 * @param {unknown} error
 * @returns {string}
 */
export function safeError(error) {
  if (error instanceof Error && error.message.length > 0) return error.message
  return 'request failed'
}

/**
 * Mount the plugin's routes.
 *
 * @param {object} host
 * @param {object} host.webServer
 * @param {(route: object) => () => void} host.webServer.register
 * @param {object} deps
 * @param {object} deps.operations - see {@link module:dsh-provider-openai-subscription/operations}.
 * @param {(request: {headers: object}) => 401|403|undefined} [deps.authorize] -
 *   the deployment's own trust and authentication fence, already resolved for
 *   this request. The Web runtime always supplies one and owns the no-fence
 *   fallback inside it, so omitting this is for callers that judge requests
 *   themselves.
 * @returns {() => void} disposer releasing every route.
 */
export function mountRoutes(host, deps) {
  const disposers = []

  const authorize = typeof deps.authorize === 'function' ? deps.authorize : (request) => (sameOrigin(request) ? undefined : 403)

  const release = () => {
    for (const dispose of disposers.splice(0).reverse()) {
      try {
        dispose()
      } catch {
        // A route table that already dropped this entry cannot be repaired here;
        // whatever is left must still be released.
      }
    }
  }

  const route = (method, path, handler) => {
    disposers.push(host.webServer.register({
      kind: 'exact',
      path: `${ROUTE_PREFIX}${path}`,
      handler: async (request, response) => {
        if (request.method !== method) {
          response.writeHead(405, { allow: method })
          response.end()
          return
        }
        const rejection = authorize(request)
        if (rejection !== undefined) {
          sendJson(response, rejection, {
            ok: false,
            error: rejection === 401 ? 'authentication required' : 'untrusted origin',
          })
          return
        }
        try {
          await handler(request, response)
        } catch (error) {
          sendJson(response, 500, { ok: false, error: safeError(error) })
        }
      },
    }))
  }

  try {
    route('GET', '/status', async (_request, response) => {
      sendJson(response, 200, { ok: true, data: await deps.operations.status() })
    })
  } catch (error) {
    // Nothing owns a partial registration: the route table rejects a duplicate
    // path, so a half-registered set would block the retry that fixes it.
    release()
    throw error
  }

  return release
}
