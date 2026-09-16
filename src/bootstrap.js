/**
 * Safe bootstrap entry for the OpenAI Subscription provider plugin.
 *
 * The Cordis loader only ever imports this module.  runtime.js is loaded
 * dynamically and only when the plugin has been explicitly activated, so a
 * missing dependency, DSH API mismatch, or runtime bug cannot prevent DSH from
 * starting.
 *
 * Activation failures are deliberately NOT swallowed. DSH 0.1.6 audits a
 * settled Loader tree and reports an entry that fails to activate: an entry
 * outside the required list produces one startup warning while every other
 * plugin keeps running (`packages/boot/app-boot/README.md`, "Startup and reload
 * failures"). Swallowing the failure here would instead present a failed
 * activation to the harness as a successful one, hiding the reason from the
 * startup report and from configuration HMR. Returning the activation promise
 * is what lets that audit see the real outcome.
 *
 * @module dsh-provider-openai-subscription/bootstrap
 */

import { PACKAGE_NAME } from './constants.js'
import { activeConfigProblem, normalizeConfig } from './config.js'
import { isKillSwitchPresent } from './state.js'

/**
 * Log through the Cordis context without assuming a logger exists.
 * @param {object} ctx
 * @param {'debug'|'info'|'warn'|'error'} level
 * @param {string} message
 * @param {unknown} [detail]
 */
function log(ctx, level, message, detail) {
  const logger = ctx?.logger
  if (logger && typeof logger[level] === 'function') {
    if (detail === undefined) logger[level](message)
    else logger[level](message, detail)
  }
}

/**
 * Load and run runtime.js, reporting every outcome as a value.
 *
 * A result without `error` is a legitimate inactive state (bootstrap,
 * disabled, or the kill switch). A result with `error` is a real activation
 * failure that the caller must surface to the harness.
 *
 * @param {object} ctx - Cordis context.
 * @param {unknown} rawConfig - raw cordis plugin config.
 * @param {(specifier: string) => Promise<unknown>} [dynamicImport] - test seam for import().
 * @returns {Promise<{loaded: boolean, reason?: string, error?: Error}>}
 */
export async function activateSafely(ctx, rawConfig, dynamicImport = (specifier) => import(specifier)) {
  const config = normalizeConfig(rawConfig)
  if (await isKillSwitchPresent()) {
    log(ctx, 'warn', `${PACKAGE_NAME}: disabled by kill switch; runtime not loaded`)
    return { loaded: false, reason: 'kill-switch' }
  }
  if (config.state !== 'active') {
    log(ctx, 'info', `${PACKAGE_NAME}: staying in state "${config.state}"; runtime not loaded`)
    return { loaded: false, reason: config.state }
  }
  const problem = activeConfigProblem(config)
  if (problem !== undefined) {
    const error = new Error(`${PACKAGE_NAME}: ${problem}`)
    log(ctx, 'error', error.message)
    return { loaded: false, reason: 'invalid-active-config', error }
  }
  let runtime
  try {
    runtime = await dynamicImport('./runtime.js')
  } catch (cause) {
    const error = new Error(`${PACKAGE_NAME}: runtime module could not be imported`, { cause })
    log(ctx, 'error', error.message, cause)
    return { loaded: false, reason: 'runtime-import-failed', error }
  }
  if (typeof runtime?.applyRuntime !== 'function') {
    const error = new TypeError(`${PACKAGE_NAME}: runtime module has no applyRuntime export`)
    log(ctx, 'error', error.message)
    return { loaded: false, reason: 'runtime-import-failed', error }
  }
  let result
  try {
    result = await runtime.applyRuntime(ctx, config)
  } catch (cause) {
    const error = new Error(`${PACKAGE_NAME}: runtime failed to activate`, { cause })
    log(ctx, 'error', error.message, cause)
    return { loaded: false, reason: 'runtime-apply-failed', error }
  }
  if (result?.ok !== true) {
    const error = new Error(`${PACKAGE_NAME}: runtime did not activate (${result?.reason ?? 'unknown reason'})`)
    log(ctx, 'error', error.message)
    return { loaded: false, reason: 'runtime-unavailable', error }
  }
  return { loaded: true }
}

/**
 * Cordis function-plugin apply.
 *
 * The returned promise is the entry's activation result: it resolves once the
 * runtime is serving, and rejects when an explicitly activated row could not
 * activate, so the harness startup audit reports it. Bootstrap, disabled, and
 * kill-switch states stay a normal no-op.
 *
 * @param {object} ctx - Cordis context.
 * @param {unknown} config - raw cordis plugin config.
 * @returns {Promise<void>}
 */
export async function applyBootstrap(ctx, config) {
  const result = await activateSafely(ctx, config)
  if (result.loaded === true || result.error === undefined) return
  throw result.error
}
