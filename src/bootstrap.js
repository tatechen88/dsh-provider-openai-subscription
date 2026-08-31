/**
 * Safe bootstrap entry for the OpenAI Subscription provider plugin.
 *
 * The Cordis loader only ever imports this module.  runtime.js is loaded
 * dynamically and only when the plugin has been explicitly activated, so a
 * missing dependency, DSH API mismatch, or runtime bug cannot prevent DSH
 * from starting.
 *
 * @module dsh-provider-openai-subscription/bootstrap
 */

import { PACKAGE_NAME } from './constants.js'
import { normalizeConfig, shouldLoadRuntime } from './config.js'
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
 * Load and run runtime.js in a contained way.  This function is async and
 * every failure is converted to a logged disabled state.
 *
 * @param {object} ctx - Cordis context.
 * @param {unknown} rawConfig - raw cordis plugin config.
 * @param {(specifier: string) => Promise<unknown>} [dynamicImport] - test seam for import().
 * @returns {Promise<{loaded: boolean, reason?: string}>}
 */
export async function activateSafely(ctx, rawConfig, dynamicImport = (specifier) => import(specifier)) {
  const config = normalizeConfig(rawConfig)
  if (await isKillSwitchPresent()) {
    log(ctx, 'warn', `${PACKAGE_NAME}: disabled by kill switch; runtime not loaded`)
    return { loaded: false, reason: 'kill-switch' }
  }
  if (!shouldLoadRuntime(config)) {
    log(ctx, 'info', `${PACKAGE_NAME}: staying in state "${config.state}"; runtime not loaded`)
    return { loaded: false, reason: config.state }
  }
  try {
    const runtime = /** @type {{applyRuntime?: (ctx: object, config: unknown) => Promise<void>|void}} */ (
      await dynamicImport('./runtime.js')
    )
    if (typeof runtime.applyRuntime !== 'function') {
      throw new TypeError(`${PACKAGE_NAME}: runtime module has no applyRuntime export`)
    }
    await runtime.applyRuntime(ctx, config)
    return { loaded: true }
  } catch (error) {
    log(ctx, 'error', `${PACKAGE_NAME}: runtime failed to activate; plugin remains disabled`, error)
    return { loaded: false, reason: 'runtime-failed', error: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * Cordis function-plugin apply.  It never throws: runtime activation is
 * fire-and-forget and all failures are contained.
 *
 * @param {object} ctx - Cordis context.
 * @param {unknown} config - raw cordis plugin config.
 * @returns {void}
 */
export function applyBootstrap(ctx, config) {
  void activateSafely(ctx, config).catch((error) => {
    // activateSafely already contains runtime failures; this catch covers
    // unexpected failures before the try (e.g. kill switch stat).
    log(ctx, 'error', `${PACKAGE_NAME}: bootstrap failed unexpectedly`, error)
  })
}
