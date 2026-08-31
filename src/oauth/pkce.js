/**
 * PKCE S256 helpers.
 *
 * @module dsh-provider-openai-subscription/oauth/pkce
 */

import { createHash, randomBytes } from 'node:crypto'

/**
 * Generate a high-entropy PKCE code verifier (96 random bytes, base64url).
 * @returns {string}
 */
export function generateVerifier() {
  return randomBytes(96).toString('base64url')
}

/**
 * Compute the S256 code challenge for a verifier.
 * @param {string} verifier
 * @returns {string}
 */
export function generateChallenge(verifier) {
  return createHash('sha256').update(verifier).digest('base64url')
}

/**
 * Generate a fresh PKCE pair.
 * @returns {{verifier: string, challenge: string}}
 */
export function generatePKCE() {
  const verifier = generateVerifier()
  return { verifier, challenge: generateChallenge(verifier) }
}
