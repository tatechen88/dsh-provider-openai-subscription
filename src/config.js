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
import { loadHarnessModule } from './dsh-modules.js'

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
 * The fallback plugin config schema, used when the deployment ships no
 * schemastery.
 *
 * This is a hand-written [Standard Schema](https://standardschema.dev) rather
 * than a dependency: Cordis only needs `~standard.validate`, validation stays
 * synchronous, and an invalid known field becomes a schema issue that DSH
 * reports as a failed optional entry while every other plugin keeps starting.
 *
 * The schema only judges: it returns the row's own value untouched, so
 * `normalizeConfig` stays the one place that decides what a row means, and the
 * config DSH records is the config the profile wrote.
 */
export const STANDARD_CONFIG = Object.freeze({
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

/**
 * Load the deployment's own schemastery, when it ships one.
 *
 * Asynchronous, and awaited at module scope below: the packaged Desktop keeps
 * its runtime inside `app.asar`, where only a URL import reaches it, and a
 * module-scope await is what still leaves a `Config` for the loader that imports
 * this file.
 *
 * @returns {Promise<{Schema?: object, problem?: string}>} the `Schema` entry point, or why not.
 */
async function loadSchemastery() {
  try {
    const loaded = await loadHarnessModule('@deepseek-ai/schemastery')
    // The package ships both builds; the CJS one exports the class directly,
    // while an ESM namespace carries it as `default`.
    const Schema = /** @type {{default?: object}} */ (loaded)?.default ?? loaded
    if (typeof /** @type {object} */ (Schema)?.object !== 'function') {
      return { problem: '@deepseek-ai/schemastery loaded but exports no object builder' }
    }
    return { Schema }
  } catch (error) {
    return { problem: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * Choose the config schema this deployment can actually use.
 *
 * Two things are true at once, and only one schema satisfies both:
 *
 * - the plugin must load on a harness that provides nothing (the fallback), and
 * - it must be **visible** in the native Models page, which lists a provider
 *   only when a live settings namespace exists for its `settingsNs`. DSH builds
 *   that namespace from the entry's Config schema, and only a schemastery schema
 *   projects into a form — a Standard Schema is reported as unsupported.
 *
 * So schemastery wins where it is reachable, and the built-in schema is the
 * fallback rather than a dependency: the package is never declared, never
 * installed, and its absence is not an error.
 *
 * The declared fields mirror exactly what the fallback judges, and nothing
 * stricter: unknown top-level keys pass through (forward compatibility),
 * `meter` stays free-form (its own normalizer owns those fields), and every
 * field is optional so a sparse row keeps composing.
 *
 * @param {() => object|{Schema?: object, problem?: string}} [load] - schemastery loader; a test seam.
 * @returns {{kind: 'schemastery'|'standard', schema: object, problem?: string}}
 */
export async function selectConfigSchema(load = loadSchemastery) {
  let loaded
  try {
    // The default loader is asynchronous — it imports through a URL, which is the
    // only thing that reaches a package inside a packaged archive — and the seam
    // may also be a plain function, so both are awaited here.
    loaded = await load()
  } catch (error) {
    return { kind: 'standard', schema: STANDARD_CONFIG, problem: error instanceof Error ? error.message : String(error) }
  }
  // The loader may hand back the class itself (a test seam) or a verdict.
  const Schema = typeof loaded === 'function' || typeof loaded?.object === 'function' ? loaded : loaded?.Schema
  if (Schema === undefined || Schema === null || typeof Schema.object !== 'function') {
    return {
      kind: 'standard',
      schema: STANDARD_CONFIG,
      problem: loaded?.problem ?? '@deepseek-ai/schemastery is not reachable from this install',
    }
  }
  return {
    kind: 'schemastery',
    schema: Schema.object({
      state: Schema.union([Schema.const('bootstrap'), Schema.const('disabled'), Schema.const('active')]).default('bootstrap'),
      oauth: Schema.object({ clientId: Schema.string().default('') }).default({ clientId: '' }),
      // Volatile: DSH hands these two to the running plugin instead of remounting
      // it, and the adapter adopts them (`setDefaults`). Everything else here
      // changes meaning only at activation, so marking it volatile would offer an
      // edit that silently waits for a restart. This is also what earns the entry
      // a settings namespace at all: DSH projects a form only from a schema that
      // has at least one live field.
      provider: Schema.object({
        defaultModel: Schema.string().default('').volatile(),
        reasoningEffort: Schema.string().default('').volatile(),
      }).default({ defaultModel: '', reasoningEffort: '' }),
      meter: Schema.any(),
    }),
  }
}

// Awaiting here is what keeps the plugin loadable in the packaged Desktop:
// the async import above only lands inside this module's evaluation.
const selected = await selectConfigSchema()

/** Why the fallback was used, when it was; recorded for the runtime record. */
export const CONFIG_SCHEMA_PROBLEM = selected.problem

/** Which schema the deployment got: `schemastery` when projectable, else `standard`. */
export const CONFIG_SCHEMA_KIND = selected.kind

/** The plugin config schema DSH validates before `apply()` runs. */
export const Config = selected.schema

