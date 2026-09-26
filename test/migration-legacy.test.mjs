import test from 'node:test'
import assert from 'node:assert/strict'

import { inspectLegacy, LEGACY_CREDENTIAL_KEY, LEGACY_PROVIDER_ID } from '../src/migration/legacy.js'

/**
 * The legacy plugin family is not this plugin's business to change, only to
 * report: a status line saying "the old provider and its credential are still
 * here" is the whole contract, and reading the payload is not part of it.
 */

test('inspectLegacy reports provider and credential without reading payload', async () => {
  const asked = []
  const result = await inspectLegacy({
    llm: { listProviders: () => [{ id: LEGACY_PROVIDER_ID }] },
    credentials: {
      describeRecord: async (key) => {
        asked.push(key)
        return { configured: true, kind: 'grant', writable: true }
      },
    },
  })
  assert.deepEqual(result, { providerPresent: true, credentialPresent: true, credentialKind: 'grant' })
  assert.deepEqual(asked, [LEGACY_CREDENTIAL_KEY])
})

test('inspectLegacy reports absence without inventing a credential kind', async () => {
  const result = await inspectLegacy({
    llm: { listProviders: () => [{ id: 'deepseek-official' }] },
    credentials: { describeRecord: async () => ({ configured: false, writable: false }) },
  })
  assert.deepEqual(result, { providerPresent: false, credentialPresent: false })
})

test('inspectLegacy tolerates a deployment with no llm route listing', async () => {
  const result = await inspectLegacy({
    llm: undefined,
    credentials: { describeRecord: async () => ({ configured: true, writable: true }) },
  })
  assert.equal(result.providerPresent, false)
  assert.equal(result.credentialPresent, true)
})
