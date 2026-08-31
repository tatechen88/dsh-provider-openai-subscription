#!/usr/bin/env node
/**
 * Real DSH composition smoke test.
 *
 * This script composes the plugin into a real Cordis context using the DSH
 * packages from an installed profile.  It does not require OAuth credentials
 * and does not touch a real profile.  It proves the plugin can be activated
 * inside DSH without breaking provider registration.
 *
 * Usage:
 *   DSH_NODE_MODULES="/path/to/dsh/profiles/node_modules" \
 *     node scripts/integration-smoke.mjs
 *
 * If DSH_NODE_MODULES is omitted, the script checks DSH_PROFILE and DSH_HOME
 * before the standard source-checkout locations.  No machine-specific path is
 * used as a default.
 */

import { createRequire } from 'node:module'
import { mkdtemp, rm, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { activateSafely } from '../src/bootstrap.js'

const here = dirname(fileURLToPath(import.meta.url))
const pluginRoot = join(here, '..')

/**
 * Find the installed DSH dependency surface without assuming a host path.
 * @returns {Promise<{path: string|undefined, checked: string[]}>}
 */
async function findDshNodeModules() {
  const profile = process.env.DSH_PROFILE
  const home = process.env.DSH_HOME
  const candidates = [
    process.env.DSH_NODE_MODULES,
    profile === undefined ? undefined : basename(profile) === 'node_modules' ? profile : join(profile, 'node_modules'),
    home === undefined ? undefined : join(home, 'profiles', 'node_modules'),
    home === undefined ? undefined : join(home, 'profiles', 'web', 'node_modules'),
    home === undefined ? undefined : join(home, 'profiles', 'default', 'node_modules'),
    home === undefined ? undefined : join(home, 'node_modules'),
  ].filter((candidate, index, all) => candidate !== undefined && candidate.length > 0 && all.indexOf(candidate) === index)

  for (const candidate of candidates) {
    try {
      await access(join(candidate, '@deepseek-ai', 'cordis', 'package.json'))
      return { path: candidate, checked: candidates }
    } catch {
      // Continue checking the remaining installation locations.
    }
  }
  return { path: undefined, checked: candidates }
}

const dshModules = await findDshNodeModules()
if (dshModules.path === undefined) {
  console.log(`SKIP: DSH packages not found; checked ${dshModules.checked.join(', ') || 'no configured locations'}`)
  process.exit(0)
}
const dshNodeModules = dshModules.path

const require = createRequire(join(dshNodeModules, 'noop.js'))
const { Context } = require('@deepseek-ai/cordis')
const { LocalCredentialProvider } = require('@deepseek-ai/dsh-credentials-local')
const { LlmRuntime } = require('@deepseek-ai/dsh-llm')

const dir = await mkdtemp(join(tmpdir(), 'dsh-openai-subscription-integration-'))
try {
  const ctx = new Context()
  await ctx.plugin(LocalCredentialProvider, { path: join(dir, '.credentials.yaml'), watch: false })
  await ctx.plugin(LlmRuntime)

  // Bootstrap state must not load the runtime.
  const bootstrapResult = await activateSafely(ctx, { state: 'bootstrap', oauth: { clientId: 'test' } })
  if (bootstrapResult.loaded !== false) {
    throw new Error('bootstrap state unexpectedly loaded runtime')
  }
  if (ctx.llm.listProviders().some((entry) => entry.id === 'openai-subscription')) {
    throw new Error('bootstrap state unexpectedly registered provider')
  }

  // Active state must register the provider and configurable directory.
  const activeResult = await activateSafely(ctx, { state: 'active', oauth: { clientId: 'test-client' } })
  if (activeResult.loaded !== true) {
    throw new Error(`active runtime failed: ${JSON.stringify(activeResult)}`)
  }
  const providers = ctx.llm.listProviders()
  if (!providers.some((entry) => entry.id === 'openai-subscription')) {
    throw new Error('openai-subscription provider was not registered')
  }
  const directory = ctx.llm.listConfigurableProviders()
  if (!directory.some((entry) => entry.provider === 'openai-subscription')) {
    throw new Error('openai-subscription configurable directory entry was not registered')
  }

  console.log(`OK: plugin root ${pluginRoot}`)
  console.log(`OK: bootstrap state stays inactive`)
  console.log(`OK: active state registers provider openai-subscription`)
} finally {
  await rm(dir, { recursive: true, force: true })
}
