/**
 * Plugin configuration normalization and validation.
 *
 * The configuration is intentionally simple in bootstrap phase.  The runtime
 * may later extend it with OAuth / provider / balance options, but every
 * security invariant must remain a hard-coded constant, not a config knob.
 *
 * @module dsh-provider-openai-subscription/config
 */

/** Valid plugin states. `active` is the only state that loads runtime.js. */
export const PLUGIN_STATES = Object.freeze(['bootstrap', 'disabled', 'active'])

/** Default configuration. */
export const DEFAULT_CONFIG = Object.freeze({
  state: 'bootstrap',
  oauth: Object.freeze({
    clientId: '',
  }),
  provider: Object.freeze({
    defaultModel: '',
    reasoningEffort: '',
  }),
})

/**
 * Normalize an unknown plugin config into the safe shape used by bootstrap.
 * Unknown fields are preserved for forward compatibility; known fields are
 * coerced to the default when malformed.
 *
 * @param {unknown} input - raw cordis config, usually an object.
 * @returns {{state: string, oauth: {clientId: string}, [key: string]: unknown}}
 */
export function normalizeConfig(input) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return { ...DEFAULT_CONFIG, oauth: { ...DEFAULT_CONFIG.oauth }, provider: { ...DEFAULT_CONFIG.provider } }
  }
  const record = /** @type {Record<string, unknown>} */ (input)
  const state = typeof record.state === 'string' && PLUGIN_STATES.includes(record.state)
    ? record.state
    : DEFAULT_CONFIG.state
  const oauthRaw = record.oauth
  const clientId = oauthRaw !== null && typeof oauthRaw === 'object' && !Array.isArray(oauthRaw)
    && typeof oauthRaw.clientId === 'string'
    ? oauthRaw.clientId
    : DEFAULT_CONFIG.oauth.clientId
  const providerRaw = record.provider
  const defaultModel = providerRaw !== null && typeof providerRaw === 'object' && !Array.isArray(providerRaw)
    && typeof providerRaw.defaultModel === 'string'
    ? providerRaw.defaultModel
    : DEFAULT_CONFIG.provider.defaultModel
  const reasoningEffort = providerRaw !== null && typeof providerRaw === 'object' && !Array.isArray(providerRaw)
    && typeof providerRaw.reasoningEffort === 'string'
    ? providerRaw.reasoningEffort
    : DEFAULT_CONFIG.provider.reasoningEffort
  return {
    ...record,
    state,
    oauth: { ...(oauthRaw !== null && typeof oauthRaw === 'object' && !Array.isArray(oauthRaw)
      ? oauthRaw
      : {}), clientId },
    provider: { ...(providerRaw !== null && typeof providerRaw === 'object' && !Array.isArray(providerRaw)
      ? providerRaw
      : {}), defaultModel, reasoningEffort },
  }
}

/**
 * True when the plugin is allowed to load its runtime.
 *
 * Loading is only allowed after an explicit activation (`state: active`) and
 * after an OAuth client id has been supplied.  The bootstrap phase never
 * loads runtime.js.
 *
 * @param {{state: string, oauth: {clientId: string}}} config - normalized config.
 * @returns {boolean}
 */
export function shouldLoadRuntime(config) {
  return config.state === 'active' && config.oauth.clientId.trim().length > 0
}
