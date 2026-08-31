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
 *   DSH_NODE_MODULES="D:/AI/Agents/deepseek-harness/profiles/node_modules" \
 *     node scripts/integration-smoke.mjs
 */

import { createRequire } from 'node:module'
import { mkdtemp, rm, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { activateSafely } from '../src/bootstrap.js'

const here = dirname(fileURLToPath(import.meta.url))
const pluginRoot = join(here, '..')

const dshNodeModules = process.env.DSH_NODE_MODULES
  || 'D:/AI/Agents/deepseek-harness/profiles/node_modules'

try {
  await access(join(dshNodeModules, '@deepseek-ai', 'cordis', 'package.json'))
} catch {
  console.log(`SKIP: DSH packages not found at ${dshNodeModules}`)
  process.exit(0)
}

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
