/**
 * Render contracts for the plugin's page-level surfaces.
 *
 * The meter's own surfaces are covered in `client-meter-render.test.mjs`; this
 * file renders the connection chain end to end instead — the settings page, its
 * login flow, the signed-in panel, the legacy-credential backup form and the
 * onboarding step — because those are the screens a first install actually goes
 * through and none of them had a render test.
 *
 * Assertions are deliberately language-independent: they check structure (an
 * input, an anchor, a select) and payload values, not translated copy, so a
 * copy edit cannot silently turn them into no-ops.
 *
 * @module dsh-provider-openai-subscription/test/client-page-render
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const clientFile = join(dirname(fileURLToPath(import.meta.url)), '..', 'client', 'client.js')
const PREFIX = '/plugins/openai-subscription'

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
  useMemo: (fn) => fn(),
}

const descriptor = captured.factory((specifier) => {
  if (specifier === 'react') return react
  if (specifier === '@deepseek-ai/dsh-client-ui-primitives') return { Modal: () => null, Button: () => null }
  throw new Error(`unexpected module require: ${specifier}`)
})

/** Capture the components apply() registers, keyed by their slot. */
function components() {
  const found = {}
  descriptor.apply({
    sessions: { list: { getSnapshot: () => ({ current: 's1' }), subscribe: () => () => {} } },
    modelDirectories: { directoryFor: () => ({ store: { getSnapshot: () => ({ current: { provider: 'openai-subscription' } }) } }) },
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

/** The meter settings payload a fresh install returns. */
function settingsPayload() {
  return {
    ok: true,
    data: {
      revision: 0,
      config: {
        accountKind: 'unknown',
        displayCurrency: 'CNY',
        timeZone: 'system',
        hideBalance: false,
        hideCost: false,
        contractualSchedules: [],
      },
    },
  }
}

/** Injection props for one mounted surface. */
function props(provider, extra = {}) {
  const sessionsService = { list: { getSnapshot: () => ({ current: 's1' }), subscribe: () => () => {} } }
  const modelDirectories = { directoryFor: () => ({ store: { getSnapshot: () => ({ current: { provider } }) } }) }
  return { sessionsService, modelDirectories, getLocale: () => undefined, ...extra }
}

/**
 * Mount one component in a fresh runtime and let its async effects settle.
 * @param {Function} component
 * @param {object} props
 * @returns {Promise<object|null>} the last rendered node.
 */
async function render(component, mountProps) {
  hooks = createHookRuntime()
  mounted.push(hooks)
  let node = null
  for (let pass = 0; pass < 5; pass += 1) {
    hooks.begin()
    node = component(mountProps)
    hooks.drain()
    await new Promise((resolve) => { setTimeout(resolve, 0) })
  }
  return node
}

/**
 * Re-render the mounted component, keeping its hook state.
 * @param {Function} component
 * @param {object} mountProps
 * @param {number} [passes]
 * @returns {Promise<object|null>}
 */
async function rerender(component, mountProps, passes = 4) {
  let node = null
  for (let pass = 0; pass < passes; pass += 1) {
    hooks.begin()
    node = component(mountProps)
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

/** Walk a rendered tree, invoking nested function components as React would. */
function collect(node, predicate, found = []) {
  if (node === null || node === undefined || typeof node !== 'object') return found
  if (Array.isArray(node)) {
    for (const child of node) collect(child, predicate, found)
    return found
  }
  if (typeof node.type === 'function') {
    collect(node.type(node.props), predicate, found)
    return found
  }
  if (predicate(node)) found.push(node)
  if (node.children !== undefined) collect(node.children, predicate, found)
  return found
}

/** Collect every text fragment in a rendered tree. */
function textOf(node) {
  if (node === null || node === undefined || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join(' ')
  if (typeof node !== 'object') return ''
  if (typeof node.type === 'function') return textOf(node.type(node.props))
  if (node.children === undefined) return ''
  const own = node.props !== undefined && typeof node.props.children === 'string' ? node.props.children : ''
  return `${own} ${textOf(node.children)}`.trim()
}

/**
 * Walk a rendered tree matching before expanding.
 *
 * A component that matches is returned as-is: expanding it would replace the
 * very element the test needs, such as a button that carries its own onClick.
 * Components that do not match are expanded, so the walk still reaches the
 * surfaces nested inside them.
 * @param {object|null} node
 * @param {(entry: object) => boolean} predicate
 * @param {object[]} found
 * @returns {object[]}
 */
function findTree(node, predicate, found = []) {
  if (node === null || node === undefined || typeof node !== 'object') return found
  if (Array.isArray(node)) {
    for (const child of node) findTree(child, predicate, found)
    return found
  }
  if (predicate(node)) {
    found.push(node)
    return found
  }
  if (typeof node.type === 'function') {
    findTree(node.type(node.props), predicate, found)
    return found
  }
  if (node.children !== undefined) findTree(node.children, predicate, found)
  return found
}

/**
 * The click handlers in document order, so a test can press a real button.
 * @param {object|null} node
 * @returns {Function[]}
 */
function clicksOf(node) {
  return findTree(node, (entry) => typeof entry.props?.onClick === 'function').map((entry) => entry.props.onClick)
}

/** Inputs of one `type` attribute, e.g. the password field of a backup form. */
function inputsOf(node, type) {
  return collect(node, (entry) => entry.type === 'input' && entry.props.type === type)
}

/** A signed-out but active plugin. */
const SIGNED_OUT = { configured: false, kind: 'grant', writable: true, provider: {}, migration: { providerPresent: false, credentialPresent: false } }

test('the settings page renders the connection surface and the meter panel', async () => {
  const restore = stubFetch({
    [`${PREFIX}/status`]: () => ({ ok: true, data: SIGNED_OUT }),
    [`${PREFIX}/meter/settings`]: () => settingsPayload(),
  })
  try {
    const node = await render(components()['settings.section'], props('openai-subscription'))
    assert.notEqual(node, null, 'the page renders')
    assert.equal(textOf(node).length > 0, true, 'the page renders copy')
    // The panel's own content needs its effects drained, which a tree walk does
    // not do; `client-meter-render.test.mjs` renders it directly. Here the page
    // only has to wire it in, keyed as `meter`.
    const panels = findTree(node, (entry) => typeof entry.type === 'function' && entry.props?.key === 'meter')
    assert.equal(panels.length, 1, 'the page mounts the meter settings panel')
    assert.equal(inputsOf(node, 'password').length, 0, 'no detected credential means no backup form')
  } finally {
    restore()
    unmountAll()
  }
})

test('a detected legacy credential renders the backup form', async () => {
  const restore = stubFetch({
    [`${PREFIX}/status`]: () => ({
      ok: true,
      data: { ...SIGNED_OUT, migration: { providerPresent: false, credentialPresent: true } },
    }),
    [`${PREFIX}/meter/settings`]: () => settingsPayload(),
  })
  try {
    const node = await render(components()['settings.section'], props('openai-subscription'))
    assert.equal(inputsOf(node, 'password').length, 1, 'the legacy backup form is offered')
  } finally {
    restore()
    unmountAll()
  }
})

test('starting a login renders the authorization link with rel=noreferrer', async () => {
  const AUTH_URL = 'https://auth.example.invalid/authorize?client=test'
  const restore = stubFetch({
    [`${PREFIX}/status`]: () => ({ ok: true, data: SIGNED_OUT }),
    [`${PREFIX}/meter/settings`]: () => settingsPayload(),
    [`${PREFIX}/oauth/start`]: () => ({ ok: true, data: { url: AUTH_URL } }),
  })
  try {
    const page = components()['settings.section']
    const pageProps = props('openai-subscription')
    let node = await render(page, pageProps)

    const clicks = clicksOf(node)
    assert.equal(clicks.length > 0, true, 'a signed-out page offers an action')
    clicks[0]()
    node = await rerender(page, pageProps)

    const links = collect(node, (entry) => entry.type === 'a')
    assert.equal(links.length, 1, 'the authorization link is rendered once the attempt exists')
    assert.equal(links[0].props.href, AUTH_URL)
    assert.equal(links[0].props.rel, 'noreferrer', 'an external authorization link never leaks the referrer')
    assert.equal(links[0].props.target, '_blank')
  } finally {
    restore()
    unmountAll()
  }
})

test('signed in, the page shows the account, the plan, the window and the catalog', async () => {
  const restore = stubFetch({
    [`${PREFIX}/status`]: () => ({
      ok: true,
      data: {
        configured: true,
        kind: 'grant',
        grant: { accountId: 'acct-1', email: 'ta***@gmail.com', needsReauth: false },
        provider: { defaultModel: '', reasoningEffort: '' },
        migration: { providerPresent: false, credentialPresent: false },
      },
    }),
    [`${PREFIX}/balance`]: () => ({
      ok: true,
      data: { status: 'ready', plan: 'plus', windows: [{ id: 'primary', remainingPercent: 42, resetsAt: 1_700_000_000_000 }] },
    }),
    [`${PREFIX}/models`]: () => ({ ok: true, data: [{ id: 'gpt-5', name: 'GPT-5' }] }),
    [`${PREFIX}/meter/settings`]: () => settingsPayload(),
  })
  try {
    const node = await render(components()['settings.section'], props('openai-subscription'))
    const text = textOf(node)
    assert.match(text, /acct-1/)
    assert.match(text, /ta\*\*\*@gmail\.com/)
    assert.match(text, /42%/, 'the balance window is shown')
    assert.match(text, /GPT-5/, 'the model catalog is shown')
  } finally {
    restore()
    unmountAll()
  }
})

test('the onboarding step skips an unreachable status and prompts while signed out', async () => {
  const step = components()['settings.onboarding']
  let completed = 0
  const stepProps = props(null, { stepId: 'connect', complete: () => { completed += 1 }, openSection: () => {} })

  const restoreMissing = stubFetch({})
  try {
    const node = await render(step, stepProps)
    assert.equal(node, null, 'an unreachable status keeps the step hidden')
    assert.equal(completed, 1, 'and hands the slot to the next step instead of blocking it')
  } finally {
    restoreMissing()
    unmountAll()
  }

  completed = 0
  const restore = stubFetch({
    [`${PREFIX}/status`]: () => ({ ok: true, data: SIGNED_OUT }),
    [`${PREFIX}/meter/settings`]: () => settingsPayload(),
  })
  try {
    const node = await render(step, stepProps)
    assert.notEqual(node, null, 'a signed-out active plugin prompts for the connection')
    assert.equal(completed, 0, 'the step keeps ownership until the user acts')
  } finally {
    restore()
    unmountAll()
  }
})
