/**
 * JWT metadata extraction.
 *
 * JWTs are only decoded for display/routing metadata (account id, email).
 * They are never treated as a security boundary: signature/issuer/audience
 * validation is intentionally out of scope for this read-only helper.
 *
 * @module dsh-provider-openai-subscription/oauth/jwt
 */

/**
 * Decode a JWT payload without verifying the signature.
 * @param {string} token
 * @returns {Record<string, unknown>|undefined}
 */
export function decodeJwtPayload(token) {
  if (typeof token !== 'string' || token.length === 0) return undefined
  const parts = token.split('.')
  if (parts.length !== 3 || parts[1] === undefined || parts[1].length === 0) return undefined
  try {
    const json = Buffer.from(parts[1], 'base64url').toString('utf8')
    const value = JSON.parse(json)
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : undefined
  } catch {
    return undefined
  }
}

/**
 * Extract the ChatGPT account id from id/access tokens.
 * @param {string} [idToken]
 * @param {string} [accessToken]
 * @returns {string|undefined}
 */
export function extractAccountId(idToken, accessToken) {
  for (const token of [idToken, accessToken]) {
    if (!token) continue
    const payload = decodeJwtPayload(token)
    if (!payload) continue
    const direct = payload.chatgpt_account_id
    if (typeof direct === 'string' && direct.length > 0) return direct
    const ns = payload['https://api.openai.com/auth']
    if (ns !== null && typeof ns === 'object') {
      const nsAccount = ns.chatgpt_account_id
      if (typeof nsAccount === 'string' && nsAccount.length > 0) return nsAccount
    }
    const organizations = payload.organizations
    if (Array.isArray(organizations) && organizations.length > 0) {
      const first = organizations[0]
      if (first !== null && typeof first === 'object' && typeof first.id === 'string' && first.id.length > 0) {
        return first.id
      }
    }
  }
  return undefined
}

/**
 * Extract a lowercase email from an id/access token.
 * @param {string} [idToken]
 * @param {string} [accessToken]
 * @returns {string|undefined}
 */
export function extractEmail(idToken, accessToken) {
  for (const token of [idToken, accessToken]) {
    if (!token) continue
    const payload = decodeJwtPayload(token)
    if (!payload) continue
    const email = payload.email
    if (typeof email === 'string' && email.length > 0) return email.toLowerCase()
  }
  return undefined
}
