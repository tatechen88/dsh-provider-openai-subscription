/**
 * Manual callback input parser.
 *
 * Accepts a full redirect URL, a query string, or a raw authorization code.
 * URL/query-shaped responses are only accepted when the expected state is
 * matched by the caller; raw codes are PKCE-session-bound.
 *
 * @module dsh-provider-openai-subscription/oauth/callback-parser
 */

/**
 * Parse a pasted callback input.
 * @param {string} input
 * @returns {{kind: 'url'|'query'|'raw', code?: string, state?: string}}
 */
export function parseCallbackInput(input) {
  const value = typeof input === 'string' ? input.trim() : ''
  if (value.length === 0) return { kind: 'raw' }

  try {
    const url = new URL(value)
    const fragment = new URLSearchParams(url.hash.replace(/^#/, ''))
    const source = url.searchParams.has('code') ? url.searchParams : fragment
    return {
      kind: 'url',
      code: source.get('code') ?? undefined,
      state: source.get('state') ?? undefined,
    }
  } catch {
    // not a URL; try query string
  }

  if (value.includes('code=')) {
    const params = new URLSearchParams(value.replace(/^[?#]/, ''))
    return {
      kind: 'query',
      code: params.get('code') ?? undefined,
      state: params.get('state') ?? undefined,
    }
  }

  const [code, state] = value.split('#', 2)
  return { kind: 'raw', code: code || undefined, state }
}
