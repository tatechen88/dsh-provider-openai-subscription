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
  assert.deepEqual(report.namespaceConflicts, [])
})

test('detectConflicts reports an existing provider id', () => {
  const report = detectConflicts(
    [{ id: PROVIDER_ID, name: 'Old Plugin' }],
    [],
  )
  assert.equal(report.ok, false)
  assert.deepEqual(report.providerConflicts, ['Old Plugin'])
})

test('detectConflicts reports an existing settings namespace owned by another provider', () => {
  const report = detectConflicts(
    [],
    [{ provider: 'other', displayName: 'Other Provider', settingsNs: SETTINGS_NAMESPACE }],
  )
  assert.equal(report.ok, false)
  assert.deepEqual(report.namespaceConflicts, ['Other Provider'])
})

test('detectConflicts does not report our own configurable provider', () => {
  const report = detectConflicts(
    [],
    [{ provider: PROVIDER_ID, displayName: 'OpenAI Subscription', settingsNs: SETTINGS_NAMESPACE }],
  )
  assert.equal(report.ok, true)
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
