/**
 * Accessibility contract for the first-run onboarding step.
 *
 * The `settings.onboarding` slot makes each registrant own its modal chrome,
 * `#root` inert ownership included: the shell paints none of its own. These
 * tests drive the step's mount and unmount through a fake document and assert
 * that the page behind it is unreachable while it shows, that focus starts
 * inside it, that Tab cycles within it, and that both are handed back on
 * close.
 *
 * @module dsh-provider-openai-subscription/test/client-onboarding-a11y
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createHookRuntime } from './helpers.mjs'

const clientFile = join(dirname(fileURLToPath(import.meta.url)), '..', 'client', 'client.js')

let captured = null

globalThis.window = {
  __ModuleLoader__: { load: (registration) => { captured = registration } },
  innerWidth: 1200,
  innerHeight: 800,
  localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
  addEventListener: () => {},
  removeEventListener: () => {},
  getComputedStyle: () => ({ display: 'block' }),
}

/** One fake element the focus helpers can move focus to. */
function fakeElement(name) {
  return {
    name,
    hidden: false,
    style: {},
    focused: false,
    getAttribute: () => null,
    focus() {
      this.focused = true
      document.activeElement = this
    },
  }
}

const documentListeners = []
const appRoot = { id: 'root', inert: false }
/** The dialog's focusable children, in tab order. */
let focusables = []
const surface = {
  focus() { document.activeElement = this },
  querySelectorAll: () => focusables,
}
const outside = fakeElement('outside')

globalThis.document = {
  body: { nodeName: 'BODY' },
  activeElement: outside,
  getElementById: (id) => (id === 'root' ? appRoot : null),
  querySelector: (selector) => (selector.includes('data-openai-subscription-onboarding') ? surface : null),
  addEventListener: (type, listener, capture) => { documentListeners.push({ type, listener, capture }) },
  removeEventListener: (type, listener) => {
    const index = documentListeners.findIndex((entry) => entry.type === type && entry.listener === listener)
    if (index >= 0) documentListeners.splice(index, 1)
  },
}

await import(`${pathToFileURL(clientFile).href}`)

let hooks = createHookRuntime()
const mounted = []
const react = {
  createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
  useState: (initial) => hooks.useState(initial),
  useRef: (initial) => hooks.useRef(initial),
  useEffect: (fn, deps) => hooks.useEffect(fn, deps),
  useCallback: (fn) => fn,
  useMemo: (fn) => fn(),
}

const descriptor = captured.factory((specifier) => {
  if (specifier === 'react') return react
  if (specifier === '@deepseek-ai/dsh-client-ui-primitives') return { Modal: () => null, Button: () => null }
  throw new Error(`unexpected module require: ${specifier}`)
})

/** The onboarding step the bundle registers. */
function onboardingStep() {
  let found = null
  descriptor.apply({
    sessions: { list: { getSnapshot: () => ({ current: 's1' }), subscribe: () => () => {} } },
    modelDirectories: { directoryFor: () => ({ store: { getSnapshot: () => ({ current: { provider: 'openai-subscription' } }) } }) },
    get: () => undefined,
    slots: {
      inject: (name, factory) => { factory() },
      register: (options, component) => { if (options.name === 'settings.onboarding') found = component; return () => {} },
    },
  })
  return found
}

/** Answer /status as a signed-out, active plugin so the step prompts. */
function stubFetch() {
  const original = globalThis.fetch
  globalThis.fetch = async (url) => {
    const path = String(url).split('?')[0]
    if (path.endsWith('/status')) {
      return new Response(JSON.stringify({ ok: true, data: { configured: false, state: 'active', signedIn: false } }), { status: 200 })
    }
    return new Response('{"ok":false,"error":"no stub"}', { status: 404 })
  }
  return () => { globalThis.fetch = original }
}

/**
 * Render the step until its async decision settles.
 * @param {Function} component
 * @returns {Promise<object|null>} the last rendered node.
 */
async function renderStep(component) {
  hooks = createHookRuntime()
  mounted.push(hooks)
  let node = null
  for (let pass = 0; pass < 6; pass += 1) {
    hooks.begin()
    node = component({ stepId: 'openai-subscription-connect', complete: () => {}, openSection: () => {} })
    hooks.drain()
    await new Promise((resolve) => { setTimeout(resolve, 0) })
  }
  return node
}

/** Tear down every mounted runtime, running its effect cleanups. */
function unmountAll() {
  for (const runtime of mounted.splice(0)) {
    for (const cleanup of runtime.cleanups()) if (typeof cleanup === 'function') cleanup()
  }
}

test.afterEach(() => {
  unmountAll()
  focusables = []
  documentListeners.length = 0
  appRoot.inert = false
  document.activeElement = outside
})

test('a mounted step holds #root inert, moves focus inside, and cycles Tab', async () => {
  const restore = stubFetch()
  try {
    const first = fakeElement('connect')
    const last = fakeElement('later')
    focusables = [first, last]

    const step = onboardingStep()
    const node = await renderStep(step)
    assert.notEqual(node, null, 'a signed-out active plugin must prompt')

    assert.equal(appRoot.inert, true, 'the page behind the dialog must leave the tab order')
    assert.equal(first.focused, true, 'focus starts on the first control, not on the page behind')
    assert.equal(document.activeElement, first)

    const keydown = documentListeners.find((entry) => entry.type === 'keydown')
    assert.notEqual(keydown, undefined, 'the trap listens for Tab')
    assert.equal(keydown.capture, true, 'a captured listener survives a descendant stopping propagation')

    // Tab moves forward inside the surface...
    let prevented = false
    keydown.listener({ key: 'Tab', shiftKey: false, preventDefault: () => { prevented = true } })
    assert.equal(document.activeElement, last, 'Tab advances to the next control')

    // ...and wraps from the last control back to the first instead of escaping.
    keydown.listener({ key: 'Tab', shiftKey: false, preventDefault: () => { prevented = true } })
    assert.equal(prevented, true)
    assert.equal(document.activeElement, first, 'Tab past the last control wraps, it does not leave the dialog')

    // Shift-Tab from the first wraps back to the last.
    keydown.listener({ key: 'Tab', shiftKey: true, preventDefault: () => {} })
    assert.equal(document.activeElement, last)

    // A non-Tab key is left alone.
    keydown.listener({ key: 'a', shiftKey: false, preventDefault: () => { throw new Error('must not swallow typing') } })
  } finally {
    restore()
  }
})

test('closing the step restores inert ownership and the previous focus', async () => {
  const restore = stubFetch()
  try {
    focusables = [fakeElement('connect')]
    appRoot.inert = true // a composition that already held the root inert
    const previousFocus = fakeElement('previous')
    document.activeElement = previousFocus

    const step = onboardingStep()
    await renderStep(step)
    assert.equal(appRoot.inert, true)

    unmountAll()

    assert.equal(appRoot.inert, true, 'a pre-existing inert state is restored, never cleared')
    assert.equal(documentListeners.some((entry) => entry.type === 'keydown'), false, 'the trap stops listening')
    assert.equal(document.activeElement, previousFocus, 'focus returns to whoever opened the step')
  } finally {
    restore()
  }
})
