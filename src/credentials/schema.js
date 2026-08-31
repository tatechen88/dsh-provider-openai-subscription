/**
 * Credential schema for the OpenAI Subscription provider.
 *
 * The grant is stored as an opaque `{ kind: 'grant', payload }` DSH record
 * under `llm-openai-subscription/default`.  This module owns the payload
 * shape and never exposes access/refresh tokens to callers that ask for a
 * redacted summary.
 *
 * @module dsh-provider-openai-subscription/credentials/schema
 */

/**
 * Stable credential payload error.
 */
export class CredentialSchemaError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   */
  constructor(code, message) {
    super(message)
    this.name = 'CredentialSchemaError'
    this.code = code
  }
}

/**
 * The grant payload stored in DSH.
 * @typedef {object} OpenAISubscriptionGrant
 * @property {1} schemaVersion
 * @property {'oauth'} type
 * @property {string} access
 * @property {string} refresh
 * @property {number} expires
 * @property {string} accountId
 * @property {string} [email]
 * @property {number} [obtainedAt]
 * @property {boolean} [needsReauth]
 */

/**
 * Validate an unknown grant payload into a frozen clone.
 * @param {unknown} payload
 * @returns {OpenAISubscriptionGrant}
 */
export function parseGrant(payload) {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new CredentialSchemaError('malformed-grant', 'OpenAI subscription credential grant is malformed')
  }
  const record = /** @type {Record<string, unknown>} */ (payload)
  if (record.schemaVersion !== 1) {
    throw new CredentialSchemaError('unsupported-schema', `OpenAI subscription credential schema ${String(record.schemaVersion)} is not supported`)
  }
  if (record.type !== 'oauth') {
    throw new CredentialSchemaError('unexpected-type', 'OpenAI subscription credential type must be oauth')
  }
  const access = record.access
  const refresh = record.refresh
  const expires = record.expires
  const accountId = record.accountId
  if (typeof access !== 'string' || access.length === 0) {
    throw new CredentialSchemaError('missing-access-token', 'OpenAI subscription credential has no access token')
  }
  if (typeof refresh !== 'string' || refresh.length === 0) {
    throw new CredentialSchemaError('missing-refresh-token', 'OpenAI subscription credential has no refresh token')
  }
  if (typeof expires !== 'number' || !Number.isFinite(expires) || expires <= 0) {
    throw new CredentialSchemaError('missing-expiry', 'OpenAI subscription credential has an invalid expiry')
  }
  if (typeof accountId !== 'string' || accountId.length === 0) {
    throw new CredentialSchemaError('missing-account-id', 'OpenAI subscription credential has no account id')
  }
  const email = record.email
  if (email !== undefined && (typeof email !== 'string' || email.length === 0)) {
    throw new CredentialSchemaError('malformed-email', 'OpenAI subscription credential email is malformed')
  }
  const obtainedAt = record.obtainedAt
  if (obtainedAt !== undefined && (typeof obtainedAt !== 'number' || !Number.isFinite(obtainedAt))) {
    throw new CredentialSchemaError('malformed-obtained-at', 'OpenAI subscription credential obtainedAt is malformed')
  }
  const needsReauth = record.needsReauth
  if (needsReauth !== undefined && typeof needsReauth !== 'boolean') {
    throw new CredentialSchemaError('malformed-reauth-flag', 'OpenAI subscription credential needsReauth is malformed')
  }
  return Object.freeze({
    schemaVersion: 1,
    type: 'oauth',
    access,
    refresh,
    expires,
    accountId,
    ...(email === undefined ? {} : { email }),
    ...(obtainedAt === undefined ? {} : { obtainedAt }),
    ...(needsReauth === undefined ? {} : { needsReauth }),
  })
}

/**
 * Build a grant from token-exchange output.
 *
 * @param {{access: string, refresh: string, expires: number, accountId: string, email?: string}} input
 * @returns {OpenAISubscriptionGrant}
 */
export function createGrant(input) {
  const now = Date.now()
  return parseGrant({
    schemaVersion: 1,
    type: 'oauth',
    access: input.access,
    refresh: input.refresh,
    expires: input.expires,
    accountId: input.accountId,
    ...(input.email === undefined ? {} : { email: input.email }),
    obtainedAt: now,
  })
}

/**
 * Redact a grant into a browser/diagnostic-safe summary.  Never includes
 * access, refresh, or raw JWT.
 * @param {OpenAISubscriptionGrant} grant
 * @returns {{configured: true, schemaVersion: 1, accountId: string, email?: string, expiresAt: number, needsReauth: boolean, obtainedAt?: number}}
 */
export function redactGrant(grant) {
  return {
    configured: true,
    schemaVersion: grant.schemaVersion,
    accountId: maskAccountId(grant.accountId),
    ...(grant.email === undefined ? {} : { email: maskEmail(grant.email) }),
    expiresAt: grant.expires,
    needsReauth: grant.needsReauth === true,
    ...(grant.obtainedAt === undefined ? {} : { obtainedAt: grant.obtainedAt }),
  }
}

/**
 * Mask an account id for display.  Keeps only the first 4 and last 4 chars
 * when it is long enough; otherwise shows `***`.
 * @param {string} accountId
 * @returns {string}
 */
export function maskAccountId(accountId) {
  if (accountId.length <= 8) return '***'
  return `${accountId.slice(0, 4)}...${accountId.slice(-4)}`
}

/**
 * Mask an email address for display.
 * @param {string} email
 * @returns {string}
 */
export function maskEmail(email) {
  const at = email.indexOf('@')
  if (at <= 1) return '***@***'
  return `${email.slice(0, 2)}***@${email.slice(at + 1)}`
}
