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
  const cleanups = new Map()
  const seenDeps = new Map()
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
    useEffect(fn, deps) {
      const index = cursor++
      pending.push({ index, fn, deps })
    },
    drain() {
      for (const entry of pending) {
        const previous = seenDeps.get(entry.index)
        const changed = entry.deps === undefined
          || previous === undefined
          || entry.deps.length !== previous.length
          || entry.deps.some((value, position) => !Object.is(value, previous[position]))
        if (!changed) continue
        const cleanup = cleanups.get(entry.index)
        if (typeof cleanup === 'function') cleanup()
        const next = entry.fn()
        if (typeof next === 'function') cleanups.set(entry.index, next)
        else cleanups.delete(entry.index)
        seenDeps.set(entry.index, entry.deps)
      }
    },
    cleanups() { return [...cleanups.values()] },
  }
}

const mounted = []
let hooks = createHookRuntime()
const react = {
  createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
  useState: (initial) => hooks.useState(initial),
  useRef: (initial) => hooks.useRef(initial),
  useEffect: (fn, deps) => hooks.useEffect(fn, deps),
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

/**
 * Re-render the currently mounted component, keeping its hook state.
 * @param {Function} component
 * @param {object} props
 * @param {number} [passes]
 * @returns {Promise<object|null>}
 */
async function rerender(component, props, passes = 3) {
  let node = null
  for (let pass = 0; pass < passes; pass += 1) {
    hooks.begin()
    node = component(props)
    hooks.drain()
    await new Promise((resolve) => { setTimeout(resolve, 0) })
  }
  return node
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
 * Collect every element in a rendered tree, descending through arrays and
 * invoking function components so their host elements are reachable — a button
 * built by a shared component is otherwise invisible to a structural check.
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
  if (typeof node.type === 'function') {
    collectNodes(node.type(node.props), out)
    return out
  }
  out.push(node)
  collectNodes(node.children, out)
  return out
}

test('the meter settings panel edits an enterprise agreement, and an old host leaves it silent', async () => {
  const panel = descriptor.pure.MeterSettingsPanel
  assert.equal(typeof panel, 'function', 'the settings panel is exposed for mounting')

  const posted = []
  const original = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    const path = String(url).split('?')[0]
    if (init?.method === 'PATCH' || init?.method === 'POST') {
      posted.push({ path, body: init.body === undefined ? undefined : JSON.parse(init.body) })
      return new Response(JSON.stringify({ ok: true, data: { revision: 3, config: { accountKind: 'enterprise', contractualSchedules: [] } } }), { status: 200 })
    }
    return new Response(JSON.stringify({
      ok: true,
      data: {
        revision: 2,
        config: {
          accountKind: 'enterprise',
          displayCurrency: 'CNY',
          timeZone: 'Asia/Shanghai',
          deepseekBalance: true,
          hideBalance: false,
          hideCost: false,
          contractualSchedules: [],
        },
      },
    }), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  try {
    const props = { t: (key) => descriptor.pure.translate('zh', key) }
    const node = await render(panel, props)
    const nodes = collectNodes(node)
    const selects = nodes.filter((entry) => entry.type === 'select')
    assert.equal(selects.length, 1, 'the panel offers exactly one choice')
    assert.deepEqual(
      selects[0].children.flat().map((option) => option.props.value),
      ['CNY', 'USD'],
      'and that choice is the display currency, offered in the two supported currencies',
    )
    assert.equal(selects[0].props.value, 'CNY', 'showing the value the settings carry')
    assert.deepEqual(
      nodes.filter((entry) => entry.type === 'input' || entry.type === 'textarea').length,
      0,
      'no other control remains: everything else is composition-level configuration',
    )

    selects[0].props.onChange({ target: { value: 'USD' } })
    const changed = collectNodes(await rerender(panel, props))
    const save = changed.find((entry) => entry.type === 'button' && entry.children?.[0] === '保存')
    save.props.onClick()
    await new Promise((resolve) => { setTimeout(resolve, 25) })
    const patch = posted.find((entry) => entry.body?.patch !== undefined)
    assert.deepEqual(patch.body.patch, { displayCurrency: 'USD' }, 'only the key that changed is submitted')
    assert.equal(patch.body.expectedRevision, 2, 'the save carries the revision it read')
  } finally {
    globalThis.fetch = original
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
