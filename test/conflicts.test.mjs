import test from 'node:test'
import assert from 'node:assert/strict'
import { detectConflicts, readConflictReport } from '../src/conflicts.js'
import { PROVIDER_ID, SETTINGS_NAMESPACE } from '../src/constants.js'

test('detectConflicts returns ok when identifiers are free', () => {
  const report = detectConflicts(
    [{ id: 'deepseek', name: 'DeepSeek' }],
    [{ provider: 'anthropic', displayName: 'Anthropic', settingsNs: 'llm-anthropic' }],
  )
  assert.equal(report.ok, true)
  assert.deepEqual(report.providerConflicts, [])
  assert.deepEqual(report.directoryConflicts, [])
  assert.deepEqual(report.namespaceConflicts, [])
})

test('detectConflicts reports an existing provider id', () => {
  const report = detectConflicts(
    [{ id: PROVIDER_ID, name: 'Old Plugin' }],
    [],
  )
  assert.equal(report.ok, false)
  assert.deepEqual(report.providerConflicts, ['Old Plugin'])
  assert.deepEqual(report.directoryConflicts, [])
})

test('detectConflicts reports an existing settings namespace owned by another provider', () => {
  const report = detectConflicts(
    [],
    [{ provider: 'other', displayName: 'Other Provider', settingsNs: SETTINGS_NAMESPACE }],
  )
  assert.equal(report.ok, false)
  assert.deepEqual(report.namespaceConflicts, ['Other Provider'])
})

test('detectConflicts reports a configurable provider that already declares our route', () => {
  // Another plugin declared the route without activating it, so nothing shows
  // up in listProviders() even though the directory registration would be
  // refused as a duplicate.
  const report = detectConflicts(
    [],
    [{ provider: PROVIDER_ID, displayName: 'Dormant Rival', settingsNs: 'llm-rival' }],
  )
  assert.equal(report.ok, false)
  assert.deepEqual(report.directoryConflicts, ['Dormant Rival'])
  assert.deepEqual(report.providerConflicts, [])
})

test('detectConflicts reports our own namespace declared for another provider', () => {
  const report = detectConflicts(
    [],
    [{ provider: PROVIDER_ID, displayName: 'Rival', settingsNs: SETTINGS_NAMESPACE }],
  )
  assert.equal(report.ok, false)
  assert.deepEqual(report.directoryConflicts, ['Rival'])
})

test('detectConflicts reports missing services', () => {
  const report = detectConflicts([], [], ['llm'])
  assert.equal(report.ok, false)
  assert.deepEqual(report.missingServices, ['llm'])
})

test('readConflictReport handles absent llm service without throwing', async () => {
  const report = await readConflictReport({})
  assert.equal(report.ok, false)
  assert.deepEqual(report.missingServices, ['llm'])
})

test('readConflictReport handles llm service methods throwing', async () => {
  const ctx = {
    llm: {
      listProviders() { throw new Error('boom') },
      listConfigurableProviders() { throw new Error('boom') },
    },
  }
  const report = await readConflictReport(ctx)
  assert.equal(report.ok, false)
  assert.deepEqual(report.missingServices, ['llm.listProviders', 'llm.listConfigurableProviders'])
})
