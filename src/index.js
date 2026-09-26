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
 * Services this plugin needs to reach, declared so the loader wires them.
 *
 * Cordis 4 resolves `ctx.get(name)` by walking the fiber chain and stops at the
 * first ancestor that isolates that name. `tools` and `authorization` are
 * precisely the services DSH isolates — a tool registry and an authorization
 * attempt belong to the scope that owns them — so a root-level plugin sees
 * `llm`, `credentials` and `webServer` while those two read as missing. Measured
 * in the packaged Desktop, not inferred: the runtime record written by a live
 * activation listed exactly that split.
 *
 * Declaring them moves the wait in front of `apply()`: the loader holds the entry
 * until both exist. Both are base-bundle rows, so every real profile has them —
 * but the trade is worth stating: in a composition that somehow lacks either, the
 * entry stays pending instead of reporting a warning. That is the harness's own
 * pattern for tool plugins, and the alternative (no tools at all) is worse.
 */
export const inject = ['tools', 'authorization']

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
