/**
 * Cordis plugin entry.
 *
 * @module dsh-provider-openai-subscription
 */

import { applyBootstrap } from './bootstrap.js'
import { PACKAGE_NAME } from './constants.js'

export const name = PACKAGE_NAME

/**
 * Apply the plugin safely.  See bootstrap.js for the safety contract.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {unknown} config
 * @returns {void}
 */
export function apply(ctx, config) {
  applyBootstrap(ctx, config)
}
