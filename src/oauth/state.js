/**
 * CSRF state helper for OAuth authorization requests.
 *
 * @module dsh-provider-openai-subscription/oauth/state
 */

import { randomBytes } from 'node:crypto'

/**
 * Generate a 128-bit hex state token.
 * @returns {string}
 */
export function generateState() {
  return randomBytes(16).toString('hex')
}
