import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeConfig, shouldLoadRuntime, PLUGIN_STATES, DEFAULT_CONFIG } from '../src/config.js'

test('normalizeConfig defaults a non-object input', () => {
  const config = normalizeConfig(undefined)
  assert.equal(config.state, 'bootstrap')
  assert.equal(config.oauth.clientId, '')
})

test('normalizeConfig preserves unknown fields', () => {
  const config = normalizeConfig({ state: 'active', oauth: { clientId: 'abc' }, provider: { defaultModel: 'gpt-5', reasoningEffort: 'medium' }, extra: 1 })
  assert.equal(config.extra, 1)
  assert.equal(config.state, 'active')
  assert.equal(config.oauth.clientId, 'abc')
  assert.equal(config.provider.defaultModel, 'gpt-5')
  assert.equal(config.provider.reasoningEffort, 'medium')
})

test('normalizeConfig coerces malformed provider to defaults', () => {
  assert.equal(normalizeConfig({ provider: { defaultModel: 42, reasoningEffort: null } }).provider.defaultModel, '')
  assert.equal(normalizeConfig({ provider: null }).provider.reasoningEffort, '')
})

test('normalizeConfig coerces invalid state back to bootstrap', () => {
  for (const invalid of ['enabled', 'yes', 1, undefined, null, []]) {
    assert.equal(normalizeConfig({ state: invalid }).state, 'bootstrap')
  }
})

test('normalizeConfig coerces malformed oauth to empty client id', () => {
  assert.equal(normalizeConfig({ oauth: { clientId: 42 } }).oauth.clientId, '')
  assert.equal(normalizeConfig({ oauth: null }).oauth.clientId, '')
  assert.equal(normalizeConfig({ oauth: 'x' }).oauth.clientId, '')
})

test('PLUGIN_STATES are frozen and include bootstrap, disabled, active', () => {
  assert.deepEqual([...PLUGIN_STATES], ['bootstrap', 'disabled', 'active'])
  assert.equal(Object.isFrozen(PLUGIN_STATES), true)
})

test('DEFAULT_CONFIG is frozen', () => {
  assert.equal(Object.isFrozen(DEFAULT_CONFIG), true)
  assert.equal(Object.isFrozen(DEFAULT_CONFIG.oauth), true)
})

test('shouldLoadRuntime only allows active with non-empty client id', () => {
  assert.equal(shouldLoadRuntime({ state: 'bootstrap', oauth: { clientId: 'abc' } }), false)
  assert.equal(shouldLoadRuntime({ state: 'disabled', oauth: { clientId: 'abc' } }), false)
  assert.equal(shouldLoadRuntime({ state: 'active', oauth: { clientId: '' } }), false)
  assert.equal(shouldLoadRuntime({ state: 'active', oauth: { clientId: '   ' } }), false)
  assert.equal(shouldLoadRuntime({ state: 'active', oauth: { clientId: 'abc' } }), true)
})
