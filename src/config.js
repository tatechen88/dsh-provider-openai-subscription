/**
 * Plugin configuration normalization and validation.
 *
 * The configuration is intentionally simple in bootstrap phase.  The runtime
 * may later extend it with OAuth / provider / balance options, but every
 * security invariant must remain a hard-coded constant, not a config knob.
 *
 * Normalization below is deliberately tolerant — it must never throw while DSH
 * is composing a profile. The `Config` schema exported at the bottom is what
 * makes a malformed known field loud instead: DSH validates it before `apply()`
 * runs and reports the failure through its own startup audit, so a `state: 5`
 * that used to be silently coerced into `bootstrap` now says so.
 *
 * @module dsh-provider-openai-subscription/config
 */

import { PACKAGE_NAME } from './constants.js'

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
 * The reason an `active` row cannot load, or undefined when the configuration
 * is usable.
 *
 * An explicit `state: active` is a user declaration that the plugin should
 * serve this profile, so an unusable active configuration is reported to the
 * DSH startup audit instead of silently leaving the row inactive. The
 * bootstrap and disabled states are the supported way to stay off.
 *
 * @param {{state: string, oauth: {clientId: string}}} config - normalized config.
 * @returns {string|undefined} a user-facing problem, or undefined when usable.
 */
export function activeConfigProblem(config) {
  if (config.state !== 'active') return undefined
  if (config.oauth.clientId.trim().length === 0) {
    return 'state is "active" but oauth.clientId is empty; set oauth.clientId or return the row to state "bootstrap"'
  }
  return undefined
}

/**
 * True when the plugin is allowed to load its runtime.
 *
 * Loading is only allowed after an explicit activation (`state: active`) with a
 * usable configuration.
 *
 * @param {{state: string, oauth: {clientId: string}}} config - normalized config.
 * @returns {boolean}
 */
export function shouldLoadRuntime(config) {
  return config.state === 'active' && activeConfigProblem(config) === undefined
}

/** Whether one value is a plain object rather than an array or null. */
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Whether one known field was left unset.
 *
 * YAML writes an empty block (`oauth:` with nothing after it) as `null`, and the
 * normalizer has always read both spellings as "not configured". The schema must
 * agree: a field it rejects and the normalizer accepts would make an empty block
 * stop composing a profile that used to start.
 * @param {unknown} value
 * @returns {boolean}
 */
function isUnset(value) {
  return value === undefined || value === null
}

/**
 * Collect the fields whose type or value is unambiguously wrong.
 *
 * Only fields this plugin actually reads are checked, and only for mistakes that
 * cannot be a legitimate value: an unknown top-level key and every `meter` field
 * stay free-form, because the meter normalizes its own options field by field
 * and forward compatibility depends on tolerating keys this build predates.
 *
 * @param {Record<string, unknown>} input
 * @returns {Array<{message: string, path?: string[]}>}
 */
function configIssues(input) {
  const issues = []
  if (!isUnset(input.state) && !PLUGIN_STATES.includes(/** @type {string} */ (input.state))) {
    issues.push({ message: `state must be one of ${PLUGIN_STATES.join(', ')}`, path: ['state'] })
  }
  if (!isUnset(input.oauth)) {
    if (!isPlainObject(input.oauth)) issues.push({ message: 'oauth must be an object', path: ['oauth'] })
    else if (!isUnset(input.oauth.clientId) && typeof input.oauth.clientId !== 'string') {
      issues.push({ message: 'oauth.clientId must be a string', path: ['oauth', 'clientId'] })
    }
  }
  if (!isUnset(input.provider)) {
    if (!isPlainObject(input.provider)) issues.push({ message: 'provider must be an object', path: ['provider'] })
    else {
      for (const field of ['defaultModel', 'reasoningEffort']) {
        const value = input.provider[field]
        if (!isUnset(value) && typeof value !== 'string') {
          issues.push({ message: `provider.${field} must be a string`, path: ['provider', field] })
        }
      }
    }
  }
  if (!isUnset(input.meter) && !isPlainObject(input.meter)) {
    issues.push({ message: 'meter must be an object', path: ['meter'] })
  }
  return issues
}

/**
 * The plugin config schema DSH validates before `apply()` runs.
 *
 * This is a hand-written [Standard Schema](https://standardschema.dev) rather
 * than a dependency: the plugin keeps its zero-dependency bootstrap, Cordis only
 * needs `~standard.validate`, and validation must stay synchronous. An invalid
 * known field becomes a schema issue, which DSH reports as a failed optional
 * entry while every other plugin keeps starting — the loud outcome this
 * configuration previously could not produce.
 *
 * The schema only judges: it returns the row's own value untouched, so
 * `normalizeConfig` stays the one place that decides what a row means, and the
 * config DSH records is the config the profile wrote.
 */
export const Config = Object.freeze({
  '~standard': Object.freeze({
    version: 1,
    vendor: PACKAGE_NAME,
    /**
     * @param {unknown} value - the raw composed row config.
     * @returns {{value: object}|{issues: Array<{message: string, path?: string[]}>}}
     */
    validate(value) {
      if (!isUnset(value) && !isPlainObject(value)) {
        return { issues: [{ message: 'config must be an object' }] }
      }
      const input = /** @type {Record<string, unknown>} */ (isPlainObject(value) ? value : {})
      const issues = configIssues(input)
      if (issues.length > 0) return { issues }
      return { value: input }
    },
  }),
})
