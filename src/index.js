/**
 * Cordis plugin entry.
 *
 * @module dsh-provider-openai-subscription
 */

import { applyBootstrap } from './bootstrap.js'
import { Config } from './config.js'
import { PACKAGE_NAME } from './constants.js'

export const name = PACKAGE_NAME

/**
 * Config schema DSH validates before `apply()` runs.
 *
 * Re-exported here because that is where the Loader looks for it on the plugin
 * module; see `config.js` for what it checks and why.
 */
export { Config }

/**
 * Apply the plugin.  See bootstrap.js for the safety and failure contract.
 *
 * The returned promise is the entry's activation result: DSH awaits it and
 * reports a failed optional entry as a startup warning while other plugins
 * keep running.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {unknown} config
 * @returns {Promise<void>}
 */
export function apply(ctx, config) {
  return applyBootstrap(ctx, config)
}
