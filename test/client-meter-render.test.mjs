/**
 * Render contracts for the meter's two new client surfaces.
 *
 * The pure view functions are covered elsewhere; this file executes the
 * components themselves with a minimal hook runtime, because the mistakes that
 * survive a pure test are the ones that only appear when React calls the
 * component (a bad prop, a hook after an early return, a thrown render).
 *
 * @module dsh-provider-openai-subscription/test/client-meter-render
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

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

await import(`${pathToFileURL(clientFile).href}`)

/**
 * Minimal hook runtime: index-keyed slots that survive re-renders plus an
 * effect queue drained after each render.
 *
 * One runtime serves one mounted component. Sharing slots between different
 * components would hand a component another component's state, which is how a
 * harness silently stops testing what it claims to test.
 * @returns {object}
 */
function createHookRuntime() {
  let cursor = 0
  let slots = []
  let pending = []
  let cleanups = []
  return {
    begin() { cursor = 0; pending = [] },
    useState(initial) {
      const index = cursor++
      if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial
      return [slots[index], (next) => { slots[index] = typeof next === 'function' ? next(slots[index]) : next }]
    },
    useRef(initial) {
      const index = cursor++
      if (!(index in slots)) slots[index] = { current: initial }
      return slots[index]
    },
    useEffect(fn) { pending.push(fn) },
    drain() {
      for (const cleanup of cleanups) if (typeof cleanup === 'function') cleanup()
      cleanups = pending.map((fn) => fn())
    },
    cleanups() { return cleanups },
  }
}

const mounted = []
let hooks = createHookRuntime()
const react = {
  createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
  useState: (initial) => hooks.useState(initial),
  useRef: (initial) => hooks.useRef(initial),
  useEffect: (fn) => hooks.useEffect(fn),
  useCallback: (fn) => fn,
}

const descriptor = captured.factory((specifier) => {
  if (specifier === 'react') return react
  if (specifier === '@deepseek-ai/dsh-client-ui-primitives') return { Modal: () => null, Button: () => null }
  throw new Error(`unexpected module require: ${specifier}`)
})

/** Fake session services pinning the current session and its provider. */
function services(provider) {
  const sessionsService = { list: { getSnapshot: () => ({ current: 's1' }), subscribe: () => () => {} } }
  const modelDirectories = { directoryFor: () => ({ store: { getSnapshot: () => ({ current: { provider } }) } }) }
  return { sessionsService, modelDirectories, props: { sessionsService, modelDirectories, getLocale: () => undefined } }
}

/** Capture the components apply() registers, keyed by their slot. */
function components() {
  const found = {}
  descriptor.apply({
    sessions: { list: { getSnapshot: () => ({ current: 's1' }), subscribe: () => () => {} } },
    modelDirectories: { directoryFor: () => ({ store: { getSnapshot: () => ({ current: { provider: 'deepseek-official' } }) } }) },
    get: () => undefined,
    slots: {
      inject: (name, factory) => { factory() },
      register: (options, component) => { found[options.name] = component; return () => {} },
    },
  })
  return found
}

/** A fetch stub that answers by path, so a whole page can render offline. */
function stubFetch(routes) {
  const original = globalThis.fetch
  globalThis.fetch = async (url) => {
    const path = String(url).split('?')[0]
    const handler = routes[path]
    if (handler === undefined) return new Response('{"ok":false,"error":"no stub"}', { status: 404 })
    return new Response(JSON.stringify(handler()), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  return () => { globalThis.fetch = original }
}

/**
 * Mount one component in a fresh runtime and let its async effects settle.
 * @param {Function} component
 * @param {object} props
 * @returns {Promise<object|null>} the last rendered node.
 */
async function render(component, props) {
  hooks = createHookRuntime()
  mounted.push(hooks)
  let node = null
  for (let pass = 0; pass < 4; pass += 1) {
    hooks.begin()
    node = component(props)
    hooks.drain()
    await new Promise((resolve) => { setTimeout(resolve, 0) })
  }
  return node
}

/** Tear down every runtime a test mounted. */
function unmountAll() {
  for (const runtime of mounted.splice(0)) {
    for (const cleanup of runtime.cleanups()) if (typeof cleanup === 'function') cleanup()
  }
}

/** Walk a rendered tree collecting text, invoking nested function components. */
function textOf(node) {
  if (node === null || node === undefined || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join(' ')
  if (typeof node !== 'object') return ''
  // A host element carries `children`; a function component must be called to
  // produce one, exactly as React would.
  if (typeof node.type === 'function') return textOf(node.type(node.props))
  if (node.children === undefined) return ''
  const own = node.props !== undefined && typeof node.props.children === 'string' ? node.props.children : ''
  return `${own} ${textOf(node.children)}`.trim()
}

test('the session dock renders a DeepSeek cost line from the meter payload', async () => {
  const restore = stubFetch({
    '/plugins/openai-subscription/meter/usage': () => ({
      ok: true,
      data: {
        usage: {
          session: {
            calls: 3,
            usage: { promptTokens: 12_400, outputTokens: 900 },
            cacheHitRatio: 0.64,
            amountMicros: 420_000,
            amountCurrency: 'CNY',
          },
        },
      },
    }),
  })
  try {
    const dock = components()['conversation.composer.dock']
    assert.equal(typeof dock, 'function', 'the session dock is registered')
    const { props } = services('deepseek-official')
    const node = await render(dock, props)
    const text = textOf(node)
    assert.match(text, /DeepSeek/)
    assert.match(text, /12\.4K → 900/, 'the session token line is rendered')
    assert.match(text, /缓存命中 64\.0%/, 'the cache ratio is rendered')
    assert.match(text, /¥0\.42/, 'the estimated cost is rendered for DeepSeek')
    assert.equal(node.props.title, 'DeepSeek 用量与费用')
  } finally {
    restore()
    unmountAll()
  }
})

test('the session dock shows tokens without money for an OpenAI session', async () => {
  const restore = stubFetch({
    '/plugins/openai-subscription/meter/usage': () => ({
      ok: true,
      data: { usage: { session: { calls: 2, usage: { promptTokens: 5_000, outputTokens: 200 }, cacheHitRatio: 0.5, amountMicros: 999, amountCurrency: 'CNY' } } },
    }),
  })
  try {
    const dock = components()['conversation.composer.dock']
    const { props } = services('openai-subscription')
    const text = textOf(await render(dock, props))
    assert.match(text, /OpenAI/)
    assert.match(text, /5\.0K → 200/)
    assert.doesNotMatch(text, /¥/, 'a subscription session never shows a cash amount')
  } finally {
    restore()
    unmountAll()
  }
})

test('the session dock renders nothing for an unmetered provider or an empty session', async () => {
  const restore = stubFetch({
    '/plugins/openai-subscription/meter/usage': () => ({ ok: true, data: { usage: { session: { calls: 0, usage: {} } } } }),
  })
  try {
    const dock = components()['conversation.composer.dock']
    assert.equal(await render(dock, services('anthropic').props), null, 'an unmetered provider renders nothing')
    assert.equal(await render(dock, services('deepseek-official').props), null, 'a session with no calls renders nothing')
  } finally {
    restore()
    unmountAll()
  }
})

/**
 * Collect every element in a rendered tree, descending through arrays. Function
 * components are left as leaves so a structural check stays structural.
 * @param {unknown} node
 * @param {object[]} [out]
 * @returns {object[]}
 */
function collectNodes(node, out = []) {
  if (node === null || node === undefined || typeof node !== 'object') return out
  if (Array.isArray(node)) {
    for (const child of node) collectNodes(child, out)
    return out
  }
  out.push(node)
  collectNodes(node.children, out)
  return out
}

test('the meter settings panel renders its controls, and an old host leaves it silent', async () => {
  const panel = descriptor.pure.MeterSettingsPanel
  assert.equal(typeof panel, 'function', 'the settings panel is exposed for mounting')

  const restore = stubFetch({
    '/plugins/openai-subscription/meter/settings': () => ({
      ok: true,
      data: { revision: 2, config: { accountKind: 'enterprise', displayCurrency: 'CNY', timeZone: 'Asia/Shanghai', hideBalance: true, hideCost: false } },
    }),
  })
  try {
    const node = await render(panel, { t: (key) => key })
    const text = textOf(node)
    assert.match(text, /meterTitle/, 'the panel titles itself')
    assert.match(text, /meterAccountHint/, 'the declaration caveat is shown where the choice is made')
    assert.match(text, /meterHideBalance/)
    assert.match(text, /meterHideCost/)
    const nodes = collectNodes(node)
    assert.equal(nodes.filter((entry) => entry.type === 'select').length, 3, 'account type, display currency and accounting time zone')
    assert.equal(nodes.filter((entry) => entry.type === 'label').length, 2, 'two privacy switches')
  } finally {
    restore()
    unmountAll()
  }

  // An old host has no meter routes: the panel stays silent instead of throwing.
  const restoreOld = stubFetch({})
  try {
    assert.equal(await render(panel, { t: (key) => key }), null)
  } finally {
    restoreOld()
    unmountAll()
  }
})
