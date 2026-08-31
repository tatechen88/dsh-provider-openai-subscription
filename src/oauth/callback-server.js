/**
 * Loopback OAuth callback server.
 *
 * The listener binds both 127.0.0.1 and ::1 to the same port whenever the OS
 * supports IPv6, because browsers on Windows may resolve `localhost` to either
 * stack.  A port that is occupied on either stack is treated as a hard
 * conflict; an OS that simply has no IPv6 stack may degrade to IPv4-only.
 *
 * @module dsh-provider-openai-subscription/oauth/callback-server
 */

import { createServer } from 'node:http'

/** Stable callback server error. */
export class CallbackServerError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   * @param {ErrorOptions} [options]
   */
  constructor(code, message, options) {
    super(message, options)
    this.name = 'CallbackServerError'
    this.code = code
  }
}

const SUCCESS_HTML = '<!doctype html><meta charset="utf-8"><title>DSH OpenAI Subscription</title><h2>Login complete</h2><p>You can close this tab and return to DSH.</p>'
const ERROR_HTML = (message) => `<!doctype html><meta charset="utf-8"><title>DSH OpenAI Subscription</title><h2>Login failed</h2><p>${escapeHtml(message)}</p>`

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[char])
}

function listen(server, port, host) {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      server.removeListener('listening', onListening)
      reject(error)
    }
    const onListening = () => {
      server.removeListener('error', onError)
      const address = server.address()
      resolve(address && typeof address === 'object' ? address.port : port)
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(port, host)
  })
}

/**
 * Start the dual-stack loopback callback servers.
 *
 * @param {object} options
 * @param {number} options.port
 * @param {string} options.path
 * @param {string} options.expectedState
 * @param {(code: string, state: string) => void} options.onCode
 * @param {(error: Error) => void} options.onError
 * @returns {Promise<{close: () => Promise<void>, redirectUri: string, ports: number[], servers: import('node:http').Server[]}>}
 */
export async function startCallbackServer({ port, path, expectedState, onCode, onError }) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new CallbackServerError('invalid-port', 'OAuth callback port is invalid')
  }
  if (typeof path !== 'string' || !path.startsWith('/')) {
    throw new CallbackServerError('invalid-path', 'OAuth callback path is invalid')
  }
  const servers = []

  const handler = (request, response) => {
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`)
    if (url.pathname !== path) {
      response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
      response.end('Not Found')
      return
    }
    const code = url.searchParams.get('code')
    const state = url.searchParams.get('state') ?? ''
    const error = url.searchParams.get('error') ?? ''
    const errorDescription = url.searchParams.get('error_description') ?? error
    if (error) {
      response.writeHead(400, { 'content-type': 'text/html; charset=utf-8' })
      response.end(ERROR_HTML(`Authorization failed: ${errorDescription}`))
      if (state === expectedState) onError(new CallbackServerError('authorization-failed', `Authorization failed: ${errorDescription}`))
      return
    }
    if (!code) {
      response.writeHead(400, { 'content-type': 'text/html; charset=utf-8' })
      response.end(ERROR_HTML('Missing authorization code'))
      return
    }
    if (state !== expectedState) {
      response.writeHead(400, { 'content-type': 'text/html; charset=utf-8' })
      response.end(ERROR_HTML('State mismatch'))
      onError(new CallbackServerError('state-mismatch', 'OAuth callback state mismatch'))
      return
    }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    response.end(SUCCESS_HTML)
    onCode(code, state)
  }

  const makeServer = () => {
    const server = createServer(handler)
    servers.push(server)
    return server
  }

  let ipv4Port
  try {
    ipv4Port = await listen(makeServer(), port, '127.0.0.1')
  } catch (error) {
    await closeServers(servers)
    throw new CallbackServerError('ipv4-unavailable', `OAuth callback port ${port} is unavailable on IPv4`, { cause: error })
  }

  let ipv6Supported = false
  try {
    await listen(makeServer(), ipv4Port, '::1')
    ipv6Supported = true
  } catch (error) {
    await closeServers(servers)
    const code = /** @type {NodeJS.ErrnoException} */ (error).code
    if (code === 'EAFNOSUPPORT' || code === 'EADDRNOTAVAIL') {
      // No IPv6 stack: the IPv4 listener is enough. Re-create IPv4 server.
      try {
        ipv4Port = await listen(makeServer(), port, '127.0.0.1')
      } catch (ipv4Error) {
        throw new CallbackServerError('ipv4-unavailable', 'OAuth callback port is unavailable after IPv6 retry', { cause: ipv4Error })
      }
    } else {
      // EADDRINUSE or anything else: treat as a hard conflict.
      throw new CallbackServerError('callback-port-conflict', `OAuth callback port ${port} cannot be bound on both loopback stacks`, { cause: error })
    }
  }

  const close = async () => {
    await closeServers(servers)
  }

  const redirectUri = `http://localhost:${ipv4Port}${path}`
  return {
    close,
    redirectUri,
    ports: [ipv4Port],
    servers,
    ipv6Supported,
  }
}

/**
 * Close all servers without throwing on already-closed servers.
 * @param {import('node:http').Server[]} servers
 * @returns {Promise<void>}
 */
async function closeServers(servers) {
  await Promise.all(servers.map((server) => new Promise((resolve) => {
    server.close(() => resolve())
    server.closeAllConnections?.()
  })))
}
