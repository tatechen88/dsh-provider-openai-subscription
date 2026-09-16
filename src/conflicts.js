/**
 * Runtime precondition checks.
 *
 * The runtime must never throw into the DSH loader.  Before registering any
 * provider, model directory, or route, it checks whether the plugin's unique
 * identifiers are already owned by another plugin.  Conflicts degrade the
 * plugin to disabled instead of failing DSH startup.
 *
 * @module dsh-provider-openai-subscription/conflicts
 */

import { PROVIDER_ID, SETTINGS_NAMESPACE } from './constants.js'

/**
 * A conflict report that is safe to expose to users.  Never contains tokens.
 * @typedef {object} ConflictReport
 * @property {boolean} ok true when no conflict is found.
 * @property {string[]} missingServices DSH services the runtime needs but are absent.
 * @property {string[]} providerConflicts owner names found for PROVIDER_ID.
 * @property {string[]} directoryConflicts owner names that already declare a
 *   configurable provider for PROVIDER_ID.
 * @property {string[]} namespaceConflicts owner names found for SETTINGS_NAMESPACE.
 */

/**
 * Detect conflicts from plain DSH topology snapshots. Pure and testable.
 *
 * A configurable-provider declaration is checked separately from a live adapter
 * because the two registries fail independently: another plugin may have
 * declared our provider route without activating it, so nothing appears in
 * `listProviders()` while `registerConfigurableProviders()` would still refuse
 * the duplicate and take the whole registration down with it.
 *
 * @param {readonly {id: string, name: string}[]} providers - ctx.llm.listProviders()
 * @param {readonly {provider: string, displayName: string, settingsNs: string}[]} configurable - ctx.llm.listConfigurableProviders()
 * @param {readonly string[]} missingServices - service names that were absent.
 * @returns {ConflictReport}
 */
export function detectConflicts(providers, configurable, missingServices = []) {
  const providerConflicts = providers
    .filter((entry) => entry.id === PROVIDER_ID)
    .map((entry) => entry.name)
  const directoryConflicts = configurable
    .filter((entry) => entry.provider === PROVIDER_ID)
    .map((entry) => entry.displayName)
  const namespaceConflicts = configurable
    .filter((entry) => entry.settingsNs === SETTINGS_NAMESPACE && entry.provider !== PROVIDER_ID)
    .map((entry) => entry.displayName)
  return {
    ok: missingServices.length === 0
      && providerConflicts.length === 0
      && directoryConflicts.length === 0
      && namespaceConflicts.length === 0,
    missingServices: [...missingServices],
    providerConflicts,
    directoryConflicts,
    namespaceConflicts,
  }
}

/**
 * Read one optional service.
 *
 * `get` is the only accessor a plugin context may use for a service it did not
 * declare in `inject`: Cordis throws from `ctx.llm` on such a context, so the
 * property is a fallback for a plain snapshot only, never the answer for a real
 * context whose `get` reported the service absent.
 *
 * @param {object} ctx - Cordis context or a plain snapshot of one.
 * @param {string} name - service name.
 * @returns {unknown} the service, or undefined when it is absent.
 */
function optionalService(ctx, name) {
  if (typeof ctx?.get === 'function') return ctx.get(name)
  try {
    return ctx?.[name]
  } catch {
    // Absent is a value here, and refusing the property is one way Cordis says so.
    return undefined
  }
}

/**
 * Read the DSH topology through optional services and return a conflict report.
 * Missing services are reported, not thrown.
 *
 * @param {object} ctx - Cordis context.
 * @returns {Promise<ConflictReport>}
 */
export async function readConflictReport(ctx) {
  const missingServices = []
  const llm = optionalService(ctx, 'llm')
  let providers = []
  let configurable = []
  if (llm === undefined || typeof llm.listProviders !== 'function') {
    missingServices.push('llm')
  } else {
    try {
      providers = llm.listProviders()
    } catch {
      providers = []
      missingServices.push('llm.listProviders')
    }
  }
  if (llm === undefined || typeof llm.listConfigurableProviders !== 'function') {
    if (!missingServices.includes('llm')) missingServices.push('llm.listConfigurableProviders')
  } else {
    try {
      configurable = llm.listConfigurableProviders()
    } catch {
      configurable = []
      missingServices.push('llm.listConfigurableProviders')
    }
  }
  return detectConflicts(providers, configurable, missingServices)
}
