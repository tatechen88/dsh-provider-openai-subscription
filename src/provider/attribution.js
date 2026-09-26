/**
 * Provider request attribution.
 *
 * DSH 0.1.6 requires every provider HTTP request to carry the app-attribution
 * header produced by `attributionHeaders()` from `@deepseek-ai/dsh-llm`
 * (`packages/llm/llm/src/index.ts`, "Every provider HTTP request must include
 * `attributionHeaders()`").
 *
 * That package belongs to the running deployment rather than to this plugin,
 * and a `link:`-installed checkout resolves bare specifiers from its real path
 * outside the profile's `node_modules`, so the helper is resolved lazily through
 * the shared anchors in
 * {@link module:dsh-provider-openai-subscription/dsh-modules}: the official one
 * wins whenever it is importable, and a versioned local identity keeps the
 * required header present when it is not.
 *
 * @module dsh-provider-openai-subscription/provider/attribution
 */

import { createRequire } from 'node:module'

import { loadHarnessModule } from '../dsh-modules.js'

/** Repository home of the fallback identity. */
const FALLBACK_URL = 'https://github.com/tatechen88/dsh-provider-openai-subscription'

/**
 * The plugin's own version, so the fallback header still identifies a build.
 * @returns {string} the manifest version, or `unknown` when it cannot be read.
 */
export function ownVersion() {
  try {
    const { version } = createRequire(import.meta.url)('../../package.json')
    return typeof version === 'string' && version.length > 0 ? version : 'unknown'
  } catch {
    // A packaged install without its manifest still needs a header; the
    // identity stays honest about not knowing the build.
    return 'unknown'
  }
}

/** Versioned identity sent when the harness helper is unreachable. */
export const FALLBACK_USER_AGENT = `dsh-provider-openai-subscription/${ownVersion()} (+${FALLBACK_URL})`

/**
 * Whether one candidate is a usable header record.
 * @param {unknown} value
 * @returns {boolean}
 */
function isHeaderRecord(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const entries = Object.entries(value)
  return entries.length > 0 && entries.every(([, header]) => typeof header === 'string')
}

/**
 * Import the harness attribution helper through the first anchor that reaches
 * it. Anchor selection lives in {@link module:dsh-provider-openai-subscription/dsh-modules}
 * so the plugin resolves every harness package the same way.
 */
function loadOfficialHelper() {
  return loadHarnessModule('@deepseek-ai/dsh-llm')
}

/**
 * Resolve the attribution headers for one provider request.
 *
 * @param {() => Promise<unknown>} [load] - loader for the harness package; a
 *   test seam for the unreachable-helper path.
 * @returns {Promise<Record<string, string>>} headers to merge into the request.
 */
export async function resolveAttributionHeaders(load = loadOfficialHelper) {
  try {
    const module = await load()
    const helper = /** @type {{attributionHeaders?: unknown}} */ (module)?.attributionHeaders
    if (typeof helper === 'function') {
      const headers = helper()
      if (isHeaderRecord(headers)) return { ...headers }
    }
  } catch {
    // The harness package is unreachable from this install: a linked
    // development checkout, a standalone run, or a unit test. The fallback
    // below keeps the header present and versioned.
  }
  return { 'user-agent': FALLBACK_USER_AGENT }
}

/** Resolved headers, memoized for the process. */
let cached

/**
 * The process-wide attribution headers. Resolution happens once; the harness
 * helper cannot change identity while the process runs.
 * @returns {Promise<Record<string, string>>}
 */
export function attributionHeaders() {
  if (cached === undefined) cached = resolveAttributionHeaders()
  return cached
}

/** Drop the memoized headers. Test seam. */
export function resetAttributionCache() {
  cached = undefined
}
