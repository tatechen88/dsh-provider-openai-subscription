/**
 * Browser-half UI contract tests.
 *
 * Loads the hand-written client bundle the way the DSH client module loader
 * would (window.__ModuleLoader__.load handoff), executes its factory with a
 * stubbed module table, and asserts the plugin descriptor, the pure
 * state-derivation surface, and the four slot registrations apply() wires.
 * Components are never rendered; React and the primitives module are empty
 * shims.
 *
 * @module dsh-provider-openai-subscription/client-ui
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const clientFile = join(dirname(fileURLToPath(import.meta.url)), '..', 'client', 'client.js')

let captured = null
globalThis.window = {
  __ModuleLoader__: {
    load: (registration) => { captured = registration },
  },
}

await import(`${pathToFileURL(clientFile).href}`)

assert.notEqual(captured, null, 'bundle must register through window.__ModuleLoader__.load')

const reactShim = {
  createElement: () => null,
  useEffect: () => {},
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useCallback: (fn) => fn,
  useRef: (initial) => ({ current: initial }),
}

function fakeRequire(specifier) {
  if (specifier === 'react') return reactShim
  if (specifier === '@deepseek-ai/dsh-client-ui-primitives') return { Modal: () => null, Button: () => null }
  throw new Error(`unexpected module-table require: ${specifier}`)
}

const descriptor = captured.factory(fakeRequire)

test('bundle exports the canonical plugin descriptor', () => {
  assert.equal(descriptor.name, 'dsh-provider-openai-subscription')
  assert.deepEqual(descriptor.inject, ['slots', 'sessions', 'modelDirectories'])
  assert.equal(typeof descriptor.apply, 'function')
})

test('pure surface: bilingual copy dictionaries stay key-aligned', () => {
  const { COPY } = descriptor.pure
  const zhKeys = Object.keys(COPY.zh).sort()
  const enKeys = Object.keys(COPY.en).sort()
  assert.deepEqual(zhKeys, enKeys, 'zh and en dictionaries must share the same key set')
  assert.ok(zhKeys.length >= 40, 'copy dictionary must cover the full UI surface')
  for (const [lang, dict] of Object.entries(COPY)) {
    for (const [key, value] of Object.entries(dict)) {
      assert.equal(typeof value, 'string', `${lang}.${key} must be a string`)
      assert.ok(value.length > 0, `${lang}.${key} must not be empty`)
    }
  }
})

test('pure surface: translate resolves languages, params, and unknown keys', () => {
  const { translate } = descriptor.pure
  assert.equal(translate('zh', 'nav'), 'OpenAI 接入')
  assert.equal(translate('en', 'nav'), 'OpenAI Connect')
  assert.equal(translate('de', 'nav'), 'OpenAI 接入', 'unknown language falls back to zh')
  assert.equal(translate('zh', 'backupDone', { backupId: 'abc' }), '旧 Provider 已加密备份：abc')
  assert.equal(translate('zh', 'no.such.key'), 'no.such.key', 'unknown keys surface verbatim')
})

test('pure surface: language picking prefers the locale service over the browser', () => {
  const { pickLanguage } = descriptor.pure
  assert.equal(pickLanguage('zh-CN', 'en-US'), 'zh')
  assert.equal(pickLanguage('en', 'zh-CN'), 'en')
  assert.equal(pickLanguage(undefined, 'zh-Hans'), 'zh')
  assert.equal(pickLanguage(undefined, 'de-DE'), 'en')
  assert.equal(pickLanguage(undefined, undefined), 'zh')
})

test('pure surface: status kinds and onboarding decisions', () => {
  const { deriveStatusKind, deriveOnboardingDecision } = descriptor.pure
  assert.equal(deriveStatusKind(true, true), 'signedIn')
  assert.equal(deriveStatusKind(true, false), 'unconfigured')
  assert.equal(deriveStatusKind(false, true), 'inactive', 'an unreachable route means an inactive plugin')
  assert.equal(deriveOnboardingDecision('loading'), 'deciding')
  assert.equal(deriveOnboardingDecision('signedIn'), 'skip')
  assert.equal(deriveOnboardingDecision('inactive'), 'skip')
  assert.equal(deriveOnboardingDecision('unconfigured'), 'prompt')
  assert.equal(deriveOnboardingDecision('error'), 'error')
  assert.equal(deriveOnboardingDecision('unexpected'), 'skip', 'unknown kinds skip defensively')
})

test('apply registers the four UI surfaces with stable identities', () => {
  const injected = []
  const registered = []
  const fakeCtx = {
    sessions: { list: { marker: true } },
    modelDirectories: { marker: true },
    get: () => undefined,
    slots: {
      inject: (name, factory) => { injected.push({ name, factory }) },
      register: (options, component) => {
        registered.push({ options, component })
        return () => {}
      },
    },
  }

  descriptor.apply(fakeCtx)

  assert.deepEqual(
    injected.map((entry) => entry.name),
    ['settings.section', 'settings.onboarding', 'settings.plugin.item', 'sidebar.footer.action'],
    'apply must wire section, onboarding, plugin-item card, and sidebar action',
  )

  for (const entry of injected) entry.factory()

  const bySlot = (slotName) => registered.filter((entry) => entry.options.name === slotName)
  const section = bySlot('settings.section')
  assert.equal(section.length, 1)
  assert.equal(section[0].options.id, 'openai-subscription')
  assert.equal(section[0].options.order, 60)
  assert.equal(typeof section[0].options.label, 'function')
  assert.ok(section[0].options.label().length > 0, 'section nav label must resolve to copy')
  assert.equal(typeof section[0].options.inject, 'function')

  const onboarding = bySlot('settings.onboarding')
  assert.equal(onboarding.length, 1)
  assert.equal(onboarding[0].options.id, 'openai-subscription-connect')
  assert.equal(onboarding[0].options.order, 100)

  const card = bySlot('settings.plugin.item')
  assert.equal(card.length, 1)
  assert.equal(card[0].options.key, 'llm-openai-subscription')

  const sidebar = bySlot('sidebar.footer.action')
  assert.equal(sidebar.length, 1)
  assert.equal(sidebar[0].options.id, 'dsh-provider-openai-subscription-balance')

  for (const entry of registered) assert.equal(typeof entry.component, 'function')

  const injectFace = section[0].options.inject()
  assert.equal(injectFace.sessionsService, fakeCtx.sessions)
  assert.equal(injectFace.modelDirectories, fakeCtx.modelDirectories)
  assert.equal(typeof injectFace.getLocale, 'function')
  assert.equal(injectFace.getLocale(), undefined, 'ctx.get falls back to undefined without a locale service')
})

test('apply tolerates missing or throwing slot seats', () => {
  descriptor.apply({})
  let threw = null
  descriptor.apply({
    slots: {
      inject: () => { threw = new Error('boom'); throw threw },
    },
  })
  assert.notEqual(threw, null)
  assert.equal(typeof descriptor.name, 'string')
})
