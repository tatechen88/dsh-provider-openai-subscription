import test from 'node:test'
import assert from 'node:assert/strict'
import { Config, normalizeConfig, shouldLoadRuntime, PLUGIN_STATES, DEFAULT_CONFIG } from '../src/config.js'

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

/** Run the exported schema the way Cordis does. */
function validate(value) {
  return Config['~standard'].validate(value)
}

test('the schema is a synchronous Standard Schema', () => {
  assert.equal(Config['~standard'].version, 1)
  assert.equal(Config['~standard'].vendor, 'dsh-provider-openai-subscription')
  const result = validate({ state: 'active' })
  assert.equal('then' in result, false, 'Cordis rejects async config validation')
})

test('the schema accepts the shape the deployed profile composes', () => {
  // Mirrors `$DSH_HOME/profiles/web/cordis.patch.yml`, which overrides the row's
  // whole config. A schema that refused this would stop a working install.
  const deployed = {
    state: 'active',
    oauth: { clientId: 'app_EMoamEEZ73f0CkXaXp7hrann' },
    provider: { defaultModel: '', reasoningEffort: '' },
    meter: { refreshPublicPrices: true },
  }
  const result = validate(deployed)
  assert.equal(result.issues, undefined, JSON.stringify(result.issues))
  assert.equal(result.value, deployed, 'the schema judges the row; it does not rewrite it')
})

test('the schema and the normalizer agree on an empty YAML block', () => {
  // `oauth:` with nothing after it is `null`. The normalizer has always read
  // that as "not configured", so a schema that rejected it would stop composing
  // a profile that used to start.
  for (const empty of [{ oauth: null }, { provider: null }, { meter: null }, { state: null }]) {
    assert.equal(validate(empty).issues, undefined, `${JSON.stringify(empty)} must keep composing`)
    assert.equal(normalizeConfig(empty).state, 'bootstrap')
  }
  assert.equal(validate({ oauth: { clientId: null } }).issues, undefined)
  assert.equal(validate({ provider: { defaultModel: null, reasoningEffort: null } }).issues, undefined)
})

test('the schema accepts the shipped bundle defaults', () => {
  const result = validate(normalizeConfig(undefined))
  assert.equal(result.issues, undefined, JSON.stringify(result.issues))
  assert.equal(result.value.state, 'bootstrap')
})

test('the schema does not transform what the row declared', () => {
  // Normalization stays in one place (`normalizeConfig`), so the config DSH
  // records is the config the profile wrote.
  const declared = { state: 'active', oauth: { clientId: 'app_x' } }
  assert.equal(validate(declared).value, declared)
  assert.equal(validate(undefined).value.state, undefined, 'an absent config stays absent')
})

test('the schema accepts a missing config and an unknown extra key', () => {
  for (const value of [undefined, null, {}]) {
    assert.equal(validate(value).issues, undefined, `${String(value)} composes a usable default`)
  }
  // Forward compatibility: a key this build predates must not stop the row.
  const result = validate({ state: 'bootstrap', somethingNewer: { nested: true } })
  assert.equal(result.issues, undefined)
  assert.deepEqual(result.value.somethingNewer, { nested: true })
})

test('the schema refuses the malformed fields that used to be coerced away', () => {
  const cases = [
    [{ state: 5 }, /state must be one of/],
    [{ state: 'enabled' }, /state must be one of/],
    [{ oauth: 'x' }, /oauth must be an object/],
    [{ oauth: [] }, /oauth must be an object/],
    [{ oauth: { clientId: 42 } }, /oauth\.clientId must be a string/],
    [{ provider: 'x' }, /provider must be an object/],
    [{ provider: { defaultModel: 42 } }, /provider\.defaultModel must be a string/],
    [{ provider: { reasoningEffort: 0 } }, /provider\.reasoningEffort must be a string/],
    [{ meter: 'x' }, /meter must be an object/],
    ['nope', /config must be an object/],
    [[], /config must be an object/],
    [7, /config must be an object/],
  ]
  for (const [input, pattern] of cases) {
    const result = validate(input)
    assert.notEqual(result.issues, undefined, `${JSON.stringify(input)} must be refused`)
    assert.match(result.issues[0].message, pattern)
    assert.equal(result.value, undefined, 'a refused config carries no value')
  }
})

test('a schema issue names the field that is wrong', () => {
  const result = validate({ provider: { defaultModel: 42 } })
  assert.deepEqual(result.issues[0].path, ['provider', 'defaultModel'])
})

test('the schema leaves every meter field free-form', () => {
  // The meter normalizes its own options field by field and must keep accepting
  // keys this build does not know.
  const result = validate({ meter: { retentionDays: 30, somethingNewer: true } })
  assert.equal(result.issues, undefined, JSON.stringify(result.issues))
})
