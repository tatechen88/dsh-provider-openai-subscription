/**
 * Credential repository over DSH `ctx.credentials` records.
 *
 * The plugin never touches `.credentials.yaml` directly and never stores OAuth
 * tokens anywhere except through the DSH credential record seam.
 *
 * @module dsh-provider-openai-subscription/credentials/repository
 */

import { CREDENTIAL_KEY } from '../constants.js'
import { parseGrant, redactGrant, CredentialSchemaError } from './schema.js'

/**
 * Error raised when the credential service is unavailable or a write fails.
 */
export class CredentialRepositoryError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   */
  constructor(code, message) {
    super(message)
    this.name = 'CredentialRepositoryError'
    this.code = code
  }
}

/**
 * Credential repository over a subset of DSH `ctx.credentials`.
 */
export class CredentialRepository {
  /**
   * @param {object} provider
   * @param {(key: string) => Promise<unknown|undefined>} provider.readRecord
   * @param {(key: string, mutate: (current: unknown|undefined) => Promise<unknown|undefined>) => Promise<unknown|undefined>} provider.modifyRecord
   * @param {(key: string) => Promise<void>} provider.deleteRecord
   * @param {(key: string) => Promise<{configured: boolean, kind?: string, writable: boolean}>} [provider.describeRecord]
   * @param {string} [key]
   */
  constructor(provider, key = CREDENTIAL_KEY) {
    if (!provider || typeof provider.readRecord !== 'function' || typeof provider.modifyRecord !== 'function') {
      throw new CredentialRepositoryError('no-credential-service', 'DSH credentials service is unavailable')
    }
    this.provider = provider
    this.key = key
  }

  /**
   * Read and validate the current grant.
   * @returns {Promise<import('./schema.js').OpenAISubscriptionGrant|undefined>}
   */
  async read() {
    const record = await this.provider.readRecord(this.key)
    if (record === undefined || record === null) return undefined
    if (typeof record !== 'object' || record.kind !== 'grant') {
      throw new CredentialSchemaError('unexpected-record', 'OpenAI subscription credential record has an unexpected kind')
    }
    return parseGrant(record.payload)
  }

  /**
   * Replace the stored grant.
   * @param {import('./schema.js').OpenAISubscriptionGrant} grant
   * @returns {Promise<import('./schema.js').OpenAISubscriptionGrant>}
   */
  async write(grant) {
    const parsed = parseGrant(grant)
    const record = await this.provider.modifyRecord(this.key, () => Promise.resolve({ kind: 'grant', payload: parsed }))
    if (record === undefined || record === null || record.kind !== 'grant') {
      throw new CredentialRepositoryError('write-failed', 'OpenAI subscription credential write did not persist')
    }
    return parseGrant(record.payload)
  }

  /**
   * Atomic read-modify-write over the grant.
   * @param {(current: import('./schema.js').OpenAISubscriptionGrant|undefined) => Promise<import('./schema.js').OpenAISubscriptionGrant|undefined>} mutate
   * @returns {Promise<import('./schema.js').OpenAISubscriptionGrant|undefined>}
   */
  async mutate(mutate) {
    const record = await this.provider.modifyRecord(this.key, async (current) => {
      const currentGrant = current !== undefined && current !== null && typeof current === 'object' && current.kind === 'grant'
        ? parseGrant(current.payload)
        : undefined
      const next = await mutate(currentGrant)
      return next === undefined ? undefined : { kind: 'grant', payload: parseGrant(next) }
    })
    if (record === undefined || record === null) return undefined
    if (record.kind !== 'grant') throw new CredentialSchemaError('unexpected-record', 'OpenAI subscription credential record has an unexpected kind')
    return parseGrant(record.payload)
  }

  /**
   * Delete the stored grant.
   * @returns {Promise<void>}
   */
  async delete() {
    if (typeof this.provider.deleteRecord !== 'function') {
      throw new CredentialRepositoryError('no-delete', 'DSH credentials service cannot delete records')
    }
    await this.provider.deleteRecord(this.key)
  }

  /**
   * Describe the record without exposing tokens.
   * @returns {Promise<{configured: boolean, kind?: string, writable: boolean, grant?: ReturnType<typeof redactGrant>}>}
   */
  async status() {
    const info = typeof this.provider.describeRecord === 'function'
      ? await this.provider.describeRecord(this.key)
      : undefined
    const configured = info?.configured ?? false
    const kind = info?.kind
    const writable = info?.writable ?? false
    let grant
    if (configured) {
      const current = await this.read().catch(() => undefined)
      grant = current === undefined ? undefined : redactGrant(current)
    }
    return { configured, ...(kind === undefined ? {} : { kind }), writable, ...(grant === undefined ? {} : { grant }) }
  }
}
