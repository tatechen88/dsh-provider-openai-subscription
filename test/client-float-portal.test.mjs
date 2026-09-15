/**
 * Floating placement contracts for the meter indicator.
 *
 * The indicator is mounted inside the sidebar, which clips its subtree: a
 * `position: fixed` descendant is still cut off at the sidebar's edge when an
 * ancestor that animates with a transform is also its containing block. These
 * tests mount the component with a document and a `react-dom` entry in the
 * module table, and assert that the card and a detached panel leave that
 * subtree entirely, and that the card retracts instead of staying open.
 *
 * `client-ui.test.mjs` covers the same component with no `react-dom` entry,
 * where both elements stay where they were rendered.
 *
 * @module dsh-provider-openai-subscription/test/client-float-portal
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createHookRuntime } from './helpers.mjs'

const clientFile = join(dirname(fileURLToPath(import.meta.url)), '..', 'client', 'client.js')

let captured = null
const storedValues = new Map()
const windowListeners = []
const documentListeners = []
const portals = []
const timers = []
const realSetTimeout = globalThis.setTimeout

globalThis.window = {
  __ModuleLoader__: { load: (registration) => { captured = registration } },
  innerWidth: 420,
  innerHeight: 800,
  localStorage: {
    getItem: (key) => (storedValues.has(key) ? storedValues.get(key) : null),
    setItem: (key, value) => { storedValues.set(key, String(value)) },
    removeItem: (key) => { storedValues.delete(key) },
  },
  addEventListener: (type, listener) => { windowListeners.push({ type, listener }) },
  removeEventListener: (type, listener) => {
    const index = windowListeners.findIndex((entry) => entry.type === type && entry.listener === listener)
    if (index >= 0) windowListeners.splice(index, 1)
  },
  getComputedStyle: (node) => ({ display: node.display === undefined ? 'block' : node.display }),
}

globalThis.document = {
  body: { nodeName: 'BODY' },
  addEventListener: (type, listener, capture) => { documentListeners.push({ type, listener, capture }) },
  removeEventListener: (type, listener) => {
    const index = documentListeners.findIndex((entry) => entry.type === type && entry.listener === listener)
    if (index >= 0) documentListeners.splice(index, 1)
  },
}

// Long delays are recorded instead of scheduled: the auto-collapse countdown is
// measured in seconds and a test cannot wait for it. Short delays still run,
// because the render helper below yields through one.
globalThis.setTimeout = (fn, ms, ...rest) => {
  timers.push({ fn, ms })
  return ms <= 50 ? realSetTimeout(fn, ms, ...rest) : timers.length
}

await import(`${pathToFileURL(clientFile).href}`)

assert.notEqual(captured, null, 'bundle must register through window.__ModuleLoader__.load')

let hooks = createHookRuntime()
const runtimes = [hooks]

/** Tear down every runtime a test mounted. */
function unmountAll() {
  for (const runtime of runtimes.splice(0)) {
    for (const cleanup of runtime.cleanups()) if (typeof cleanup === 'function') cleanup()
  }
}

const reactShim = {
  createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
  useEffect: (fn, deps) => hooks.useEffect(fn, deps),
  useState: (initial) => hooks.useState(initial),
  useCallback: (fn) => fn,
  useRef: (initial) => hooks.useRef(initial),
}

const descriptor = captured.factory((specifier) => {
  if (specifier === 'react') return reactShim
  if (specifier === 'react-dom') {
    return {
      createPortal: (element, container) => {
        const portal = { type: 'portal', element, container }
        portals.push(portal)
        return portal
      },
    }
  }
  if (specifier === '@deepseek-ai/dsh-client-ui-primitives') return { Modal: () => null, Button: () => null }
  throw new Error(`unexpected module-table require: ${specifier}`)
})

/** Walk a rendered tree, following portals the way React mounts them. */
function find(tree, predicate) {
  if (tree === null || tree === undefined || typeof tree !== 'object') return null
  if (Array.isArray(tree)) {
    for (const child of tree) {
      const hit = find(child, predicate)
      if (hit !== null) return hit
    }
    return null
  }
  if (predicate(tree) === true) return tree
  if (tree.element !== undefined) {
    const hit = find(tree.element, predicate)
    if (hit !== null) return hit
  }
  return find(tree.children, predicate)
}

const buttonOf = (tree) => find(tree, (node) => node.type === 'button')
const cardOf = (tree) => find(tree, (node) => node.props !== undefined && node.props['data-details'] === 'meter')

/** A fetch stub answering the meter read with a funded DeepSeek account. */
function stubFetch() {
  const original = globalThis.fetch
  globalThis.fetch = async (url) => {
    const path = String(url).split('?')[0]
    if (path === '/plugins/openai-subscription/meter/usage') {
      return new Response(JSON.stringify({
        ok: true,
        data: {
          deepseek: { status: 'ok', available: true, fetchedAt: 1, infos: [], primary: { currency: 'CNY', total: 86.2 }, message: '' },
          usage: { today: { calls: 1, usage: { promptTokens: 1_000, outputTokens: 100 }, amountMicros: 420_000, amountCurrency: 'CNY' } },
        },
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    return new Response('{"ok":false,"error":"no stub"}', { status: 404 })
  }
  return () => { globalThis.fetch = original }
}

/**
 * Mount the sidebar indicator over a scripted DOM node.
 * @param {string} provider - the provider the session currently runs.
 * @returns {object} render helpers, the committed node, and the mutable state.
 */
function mount(provider) {
  let component = null
  const state = { provider }
  const sessionListeners = []
  // The component reads the provider through this subscription, so a switch is
  // only observable once the list notifies — exactly what the real service does.
  const sessionsService = {
    list: {
      getSnapshot: () => ({ current: 's1' }),
      subscribe: (listener) => { sessionListeners.push(listener); return () => {} },
    },
  }
  const modelDirectories = {
    directoryFor: () => ({ store: { getSnapshot: () => ({ current: { provider: state.provider } }) } }),
  }
  descriptor.apply({
    sessions: sessionsService,
    modelDirectories,
    get: () => undefined,
    slots: {
      inject: (name, factory) => { if (name === 'sidebar.footer.action') factory() },
      register: (options, registered) => {
        if (options.name === 'sidebar.footer.action') component = registered
        return () => {}
      },
    },
  })
  const props = { sessionsService, modelDirectories, getLocale: () => undefined }
  const seat = { style: { flexWrap: '' }, parentElement: null, display: 'flex' }
  const slotWrapper = { style: {}, parentElement: seat, display: 'contents', children: [] }
  const domNode = {
    parentElement: slotWrapper,
    getBoundingClientRect: () => ({ left: 12, top: 760, width: 24, height: 24 }),
    setPointerCapture: () => {},
    contains: () => false,
  }
  portals.length = 0
  timers.length = 0
  // A fresh runtime per mount: sharing slots between two mounts would hand the
  // component the previous test's state.
  hooks = createHookRuntime()
  runtimes.push(hooks)
  let committed = null
  const renderOnce = async () => {
    hooks.begin()
    const node = component(props)
    const button = buttonOf(node)
    committed = button
    if (button !== null) {
      const ref = button.props.ref
      if (typeof ref === 'function') ref(domNode)
      else if (ref !== null && ref !== undefined) ref.current = domNode
    }
    hooks.drain()
    // One turn for the meter read the poll effect starts, and for the state
    // update it lands on, to reach the next render.
    await new Promise((resolve) => { realSetTimeout(resolve, 0) })
    return node
  }
  return {
    renderOnce,
    domNode,
    state,
    committed: () => committed,
    switchProvider: (next) => {
      state.provider = next
      for (const listener of sessionListeners) listener()
    },
  }
}

/** Render until the indicator exists, then open its card. */
async function openCard(bundle) {
  let node = await bundle.renderOnce()
  for (let pass = 0; pass < 3 && buttonOf(node) === null; pass += 1) node = await bundle.renderOnce()
  const button = buttonOf(node)
  assert.notEqual(button, null, 'the indicator renders')
  button.props.onClick()
  return bundle.renderOnce()
}

test('a detached indicator leaves its seat for the document body', async () => {
  const restore = stubFetch()
  const bundle = mount('openai-subscription')
  try {
    let node = await bundle.renderOnce()
    node = await bundle.renderOnce()
    assert.equal(portals.length, 0, 'docked, the indicator is rendered where the slot put it')
    assert.equal(buttonOf(node).props.style.position, undefined)

    const pointer = (overrides) => ({ preventDefault: () => {}, ...overrides })
    buttonOf(node).props.onPointerDown(pointer({ button: 0, pointerId: 1, clientX: 20, clientY: 770, currentTarget: bundle.domNode }))
    buttonOf(node).props.onPointerMove(pointer({ pointerId: 1, clientX: 200, clientY: 300, currentTarget: bundle.domNode }))
    const floated = await bundle.renderOnce()

    assert.equal(portals.length, 1, 'a dragged-out panel is attached to the body, not to the sidebar')
    assert.equal(portals[0].container, globalThis.document.body, 'and the body is what it attaches to')
    assert.equal(portals[0].element.type, 'button', 'the floating numbers themselves are the attached element')
    assert.equal(portals[0].element.props.style.position, 'fixed', 'positioned against the viewport')
    assert.equal(portals[0].element.props.style.zIndex, 120, 'and above the application chrome')
    assert.equal(buttonOf(floated).props.style.position, 'fixed', 'the tree still reaches it through the portal')
  } finally {
    restore()
    unmountAll()
  }
})

test('the card opens as a floating panel instead of inside the sidebar', async () => {
  const restore = stubFetch()
  const bundle = mount('openai-subscription')
  try {
    const node = await openCard(bundle)
    const card = cardOf(node)
    assert.notEqual(card, null, 'the click reveals the card')
    const portal = portals.find((entry) => entry.element.props !== undefined && entry.element.props['data-details'] === 'meter')
    assert.notEqual(portal, undefined, 'the card is attached to the body, so the sidebar cannot clip it')
    assert.equal(portal.container, globalThis.document.body)
    assert.equal(card.props.style.position, 'fixed', 'the card positions against the viewport')
    assert.equal(card.props.style.zIndex, 120, 'above the chrome it floats over')
    assert.equal(card.props.style.whiteSpace, 'normal', 'and wraps its lines instead of clipping them')
    assert.equal(card.props.style.textOverflow, undefined, 'no ellipsis: the panel has room for the whole reading')
    assert.ok(Number(card.props.style.width) <= globalThis.window.innerWidth, 'never wider than the viewport')
    assert.ok(Number(card.props.style.maxHeight) <= globalThis.window.innerHeight, 'and never taller')
  } finally {
    restore()
    unmountAll()
  }
})

test('the card retracts on its own, and a press outside retracts it sooner', async () => {
  const restore = stubFetch()
  const bundle = mount('openai-subscription')
  try {
    assert.notEqual(cardOf(await openCard(bundle)), null, 'the card is open')
    const press = documentListeners.filter((entry) => entry.type === 'pointerdown')
    assert.equal(press.length, 1, 'an open card listens for a press outside it')
    assert.equal(press[0].capture, true, 'in the capture phase, so a swallowed press still counts')

    // A press inside the card is not a dismissal.
    press[0].listener({ target: { closest: () => ({}) } })
    assert.notEqual(cardOf(await bundle.renderOnce()), null, 'a press on the card itself leaves it open')

    // Nor is a press on the indicator that opened it.
    const anchor = bundle.domNode
    anchor.contains = (target) => target === anchor
    press[0].listener({ target: anchor })
    assert.notEqual(cardOf(await bundle.renderOnce()), null, 'a press on the indicator leaves it open')

    anchor.contains = () => false
    press[0].listener({ target: { closest: () => null } })
    assert.equal(cardOf(await bundle.renderOnce()), null, 'a press anywhere else retracts it')
    assert.equal(documentListeners.filter((entry) => entry.type === 'pointerdown').length, 0, 'and its listener goes with it')

    // Reopened, the countdown alone retracts it.
    timers.length = 0
    await openCard(bundle)
    const countdown = timers.filter((entry) => entry.ms === descriptor.pure.AUTO_COLLAPSE_MS)
    assert.equal(countdown.length, 1, 'the card arms one auto-collapse timer')
    assert.ok(descriptor.pure.AUTO_COLLAPSE_MS >= 5_000, 'long enough to read the numbers')
    countdown[0].fn()
    assert.equal(cardOf(await bundle.renderOnce()), null, 'the countdown retracts the card')
  } finally {
    restore()
    unmountAll()
  }
})

test('switching the model retracts a card that belonged to the previous one', async () => {
  const restore = stubFetch()
  const bundle = mount('openai-subscription')
  try {
    assert.notEqual(cardOf(await openCard(bundle)), null, 'the card opens for the running model')
    bundle.switchProvider('deepseek-official')
    // The retract is an effect: it closes the card on the render after the one
    // that saw the new provider, exactly as React applies a state update.
    let node = await bundle.renderOnce()
    node = await bundle.renderOnce()
    for (let pass = 0; pass < 3 && buttonOf(node) === null; pass += 1) node = await bundle.renderOnce()
    assert.notEqual(buttonOf(node), null, 'the indicator is back for the new model')
    assert.equal(cardOf(node), null, 'and the card the user left open did not come back with it')
  } finally {
    restore()
    unmountAll()
  }
})
