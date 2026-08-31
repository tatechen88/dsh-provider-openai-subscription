import test from 'node:test'
import assert from 'node:assert/strict'
import {
  PACKAGE_NAME, ROW_ID, PROVIDER_ID, SETTINGS_NAMESPACE,
  CREDENTIAL_SCOPE, CREDENTIAL_ID, CREDENTIAL_KEY, ROUTE_PREFIX, KILL_SWITCH_FILENAME,
} from '../src/constants.js'

test('identifiers are unique and independent from legacy openai-codex', () => {
  assert.equal(PACKAGE_NAME, 'dsh-provider-openai-subscription')
  assert.equal(ROW_ID, 'llm-openai-subscription')
  assert.equal(PROVIDER_ID, 'openai-subscription')
  assert.equal(SETTINGS_NAMESPACE, 'llm-openai-subscription')
  assert.equal(CREDENTIAL_KEY, 'llm-openai-subscription/default')
  assert.equal(ROUTE_PREFIX, '/plugins/openai-subscription')
  assert.equal(KILL_SWITCH_FILENAME, 'openai-subscription.disabled')

  // The plugin must not claim the legacy provider id.
  assert.notEqual(PROVIDER_ID, 'openai-codex')
  assert.notEqual(ROW_ID, 'llm-openai-codex')
  assert.equal(CREDENTIAL_SCOPE, 'llm-openai-subscription')
  assert.equal(CREDENTIAL_ID, 'default')
})
