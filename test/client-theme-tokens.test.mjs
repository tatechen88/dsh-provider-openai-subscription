/**
 * Theme-token contract for the client bundle.
 *
 * DSH's style reference (`docs/web-styling.md`) requires feature components to
 * consume `--dsw-alias-*` semantic tokens and forbids literal colors, because a
 * literal encodes one theme's values: this bundle shipped a dark palette that
 * stayed dark in the light theme. The bundle has no build step and so cannot use
 * the CSS Modules the first-party client packages use, but an inline
 * `var(--dsw-alias-*)` still consumes the theme rather than hardcoding it.
 *
 * This is a source-level guard: it reads the bundle as text, because the failure
 * it prevents is invisible in a rendered tree — the styles are correct until the
 * theme changes.
 *
 * @module dsh-provider-openai-subscription/test/client-theme-tokens
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const clientFile = join(dirname(fileURLToPath(import.meta.url)), '..', 'client', 'client.js')

/** A hex color, however it is spelled. */
const HEX_COLOR = /#[0-9a-fA-F]{3,8}\b/g
/** A theme token whose literal fallback is deliberate. */
const TOKEN_FALLBACK = /var\(\s*--dsw-[a-z0-9-]+\s*,\s*#[0-9a-fA-F]{3,8}\s*\)/g

test('every color in the client bundle comes from a theme token', async () => {
  const source = await readFile(clientFile, 'utf8')
  // A token's own fallback literal is deliberate: it keeps the previous look on
  // a shell that does not define the alias. Removing those matches leaves only
  // literals that would pin the bundle to one theme.
  const stripped = source.replace(TOKEN_FALLBACK, 'var(--dsw-token)')
  const remaining = [...new Set(stripped.match(HEX_COLOR) ?? [])]
  assert.deepEqual(remaining, [], `literal colors outside a theme token: ${remaining.join(', ')}`)
})

test('the bundle consumes the semantic aliases it needs', async () => {
  const source = await readFile(clientFile, 'utf8')
  for (const token of [
    '--dsw-alias-label-primary',
    '--dsw-alias-label-secondary',
    '--dsw-alias-label-tertiary',
    '--dsw-alias-border-l2',
    '--dsw-alias-link',
    '--dsw-alias-state-error-primary',
    '--dsw-alias-state-success-primary',
    '--dsw-alias-bg-layer-2',
    '--dsw-alias-bg-mask-3',
    '--dsw-elevation-panel',
  ]) {
    assert.ok(source.includes(`var(${token}`), `the bundle must consume ${token}`)
  }
})

test('the bundle encodes no light/dark branch of its own', async () => {
  const source = await readFile(clientFile, 'utf8')
  // Theme selection belongs to the theme owner; a feature that branches on it
  // drifts the moment the shell changes either palette.
  for (const branch of ['prefers-color-scheme', 'data-theme', 'colorScheme', 'matchMedia']) {
    assert.equal(source.includes(branch), false, `the bundle must not branch on ${branch}`)
  }
})
