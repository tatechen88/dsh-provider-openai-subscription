/**
 * The authorization flow this plugin registers with `ctx.authorization`.
 *
 * Registering a flow is what makes the credential *obtainable* by any surface
 * that can drive the seam — it is not a place to ask questions of our own. The
 * flow therefore only orchestrates: it starts one of the plugin's existing
 * attempts, says what the human has to do through `session.notify`, asks a
 * question only when the chosen method genuinely cannot proceed without one, and
 * resolves once the grant is stored.
 *
 * The commit is the attempt's own: the attempt managers write through
 * `ctx.credentials`, which is exactly the write the seam watches for its
 * `credentials/record-updated` confirmation. A flow that instead resolved and
 * called `session.commit` afterwards would write the record twice.
 *
 * DSH 0.1.7 shipped no surface that calls `authorization/*`, so in practice the
 * callers today are this plugin's own tool and CLI; the seam is still the right
 * place for the flow, because it is the one contract a future surface can use
 * without this plugin changing.
 *
 * @module dsh-provider-openai-subscription/oauth/authorization-flow
 */

import { CREDENTIAL_KEY } from '../constants.js'

/**
 * Methods in preference order. The seam runs the first one when a caller names
 * none, and every id here is something this plugin can actually finish.
 */
export const FLOW_METHODS = Object.freeze([
  { id: 'oauth', label: 'Sign in with ChatGPT in a browser' },
  { id: 'manual', label: 'Paste the address the browser ended up on' },
  { id: 'device', label: 'Enter a code shown here on another device' },
])

/** Label shown wherever a surface lists what can be authorized. */
export const FLOW_LABEL = 'ChatGPT (OpenAI subscription)'

/**
 * Wait for one attempt while honoring the caller's withdrawal.
 *
 * `cancel` is called with a reason the attempt records; the seam has already
 * reported `cancelled` by the time a withdrawal reaches here, so a cancelled
 * result is not an error and must not be thrown back at it.
 *
 * @param {object} input
 * @param {object} input.session - the seam's `AuthorizationSession`.
 * @param {() => Promise<unknown>} input.result - the attempt's result promise.
 * @param {(reason: string) => void} input.cancel
 * @returns {Promise<void>}
 */
async function settle({ session, result, cancel }) {
  const onAbort = () => {
    cancel('the caller withdrew the authorization attempt')
  }
  if (session.signal?.aborted === true) {
    onAbort()
    return
  }
  session.signal?.addEventListener('abort', onAbort, { once: true })
  try {
    await result()
  } catch (error) {
    // A withdrawal is reported by the seam, not by the flow: our job is only to
    // stop the local attempt and let the caller's promise settle as cancelled.
    if (session.signal?.aborted === true) return
    throw error
  } finally {
    session.signal?.removeEventListener('abort', onAbort)
  }
}

/**
 * The attempt a manager just created, or a failure that says so.
 * @param {object} manager
 * @param {string} attemptId
 * @returns {object}
 */
function requireAttempt(manager, attemptId) {
  const attempt = manager.get(attemptId)
  if (attempt === undefined) throw new Error('the authorization attempt disappeared before it could be followed')
  return attempt
}

/**
 * Build the flow.
 *
 * @param {object} input
 * @param {object} input.attempts - the loopback attempt manager.
 * @param {object} input.devices - the device-code attempt manager.
 * @param {object} input.repository - the credential repository the attempts write through.
 * @param {string} input.clientId - OAuth client id, from the live config.
 * @param {(input: object) => Promise<object>} input.exchange - authorization-code exchange.
 * @param {string} [input.key] - credential key; defaults to this plugin's own record.
 * @returns {{key: string, label: string, methods: readonly object[], run: (session: object) => Promise<void>}}
 */
export function createAuthorizationFlow({ attempts, devices, repository, clientId, exchange, key = CREDENTIAL_KEY }) {
  if (attempts === undefined || devices === undefined) throw new TypeError('createAuthorizationFlow requires the attempt managers')
  if (typeof clientId !== 'string' || clientId.length === 0) throw new TypeError('createAuthorizationFlow requires a client id')
  return {
    key,
    label: FLOW_LABEL,
    methods: FLOW_METHODS,
    /**
     * @param {object} session - the seam's session for one attempt.
     * @returns {Promise<void>}
     */
    async run(session) {
      const method = FLOW_METHODS.some((entry) => entry.id === session.method) ? session.method : FLOW_METHODS[0].id
      // Every exit that is not a completed sign-in must close the attempt it
      // opened: a refused paste or a failed exchange would otherwise leave the
      // loopback listener up until the attempt's own timeout, blocking the very
      // retry the human is about to make.
      let active
      try {
        if (method === 'device') {
          const started = await devices.create({ clientId, repository, exchange })
          session.notify({
            message: `Open ${started.verificationUri} and enter this code: ${started.userCode}`,
            url: started.verificationUri,
            code: started.userCode,
          })
          active = requireAttempt(devices, started.attemptId)
          await settle({
            session,
            result: () => active.result(),
            cancel: (reason) => active.cancel(reason),
          })
          return
        }

        const started = await attempts.create({ clientId, repository, exchange })
        session.notify({ message: 'Open this link to sign in to ChatGPT', url: started.url })
        active = requireAttempt(attempts, started.attemptId)
        if (method === 'manual') {
          // The loopback listener is up either way, so the pasted answer can be
          // verified against the same state the URL carries.
          const pasted = await session.prompt({
            kind: 'text',
            message: 'Paste the full address your browser ended up on (or just the code).',
            placeholder: started.redirectUri,
          })
          const submitted = active.submitManualCode(pasted)
          if (submitted?.ok !== true) {
            throw new Error(`the pasted callback was refused: ${submitted?.error ?? 'unknown reason'}`)
          }
        }
        await settle({
          session,
          result: () => active.result(),
          cancel: (reason) => active.cancel(reason),
        })
      } catch (error) {
        active?.cancel('the authorization attempt failed')
        throw error
      }
    },
  }
}
