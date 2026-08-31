/**
 * Stable identifiers for the OpenAI Subscription provider plugin.
 *
 * These names are deliberately distinct from the legacy `openai-codex`
 * plugin family so a conflict with dsh-codex / dsh-codex-connect / llm-pi-ai
 * can never block DSH startup.
 *
 * @module dsh-provider-openai-subscription/constants
 */

/** npm package name. */
export const PACKAGE_NAME = 'dsh-provider-openai-subscription'

/** Cordis bundle row id. */
export const ROW_ID = 'llm-openai-subscription'

/** DSH LLM provider id registered by this plugin. */
export const PROVIDER_ID = 'openai-subscription'

/** Settings namespace owned by this plugin. */
export const SETTINGS_NAMESPACE = 'llm-openai-subscription'

/** Credential scope (owning plugin namespace). */
export const CREDENTIAL_SCOPE = 'llm-openai-subscription'

/** Credential id inside the scope. */
export const CREDENTIAL_ID = 'default'

/** Fully qualified credential key. */
export const CREDENTIAL_KEY = `${CREDENTIAL_SCOPE}/${CREDENTIAL_ID}`

/** HTTP route prefix for browser-facing local APIs. */
export const ROUTE_PREFIX = '/plugins/openai-subscription'

/** Kill-switch filename under $DSH_HOME/plugin-state. */
export const KILL_SWITCH_FILENAME = 'openai-subscription.disabled'

/** Minimum Node major supported by the runtime. */
export const MIN_NODE_MAJOR = 22
