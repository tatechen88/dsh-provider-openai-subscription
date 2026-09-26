/**
 * What a deployment may still be carrying from the previous plugin family.
 *
 * This file used to also write an encrypted backup of the legacy credential, on
 * behalf of a settings-page dialog. That entry point is gone with the browser
 * half, and nothing else can honestly replace it: a backup password cannot be
 * typed into a chat, and the CLI has no credential seam to read the record
 * through. Nothing is lost by removing it — the legacy record itself is never
 * touched or deleted by this plugin, so a copy is not what keeps it safe.
 *
 * What remains is the read that a status report needs: whether the old provider
 * and its credential are still around, so a user can be told instead of
 * wondering.
 *
 * @module dsh-provider-openai-subscription/migration/legacy
 */

/** Provider route the previous `llm-pi-ai` family served. */
export const LEGACY_PROVIDER_ID = 'openai-codex'

/** Credential record that family wrote. */
export const LEGACY_CREDENTIAL_KEY = 'llm-pi-ai/openai-codex'

/**
 * Describe whether the legacy provider and credential record are present.
 *
 * The payload is deliberately not read: this answers "is anything still there",
 * which is all a report may say about another plugin's secret.
 *
 * @param {object} input
 * @param {object} input.llm
 * @param {() => Array<{id: string}>} input.llm.listProviders
 * @param {object} input.credentials
 * @param {(key: string) => Promise<{configured: boolean, kind?: string, writable: boolean}>} input.credentials.describeRecord
 * @returns {Promise<{providerPresent: boolean, credentialPresent: boolean, credentialKind?: string}>}
 */
export async function inspectLegacy({ llm, credentials }) {
  const providerPresent = typeof llm?.listProviders === 'function'
    && llm.listProviders().some((entry) => entry.id === LEGACY_PROVIDER_ID)
  const info = await credentials.describeRecord(LEGACY_CREDENTIAL_KEY)
  return {
    providerPresent,
    credentialPresent: info.configured === true,
    ...(info.kind === undefined ? {} : { credentialKind: info.kind }),
  }
}
