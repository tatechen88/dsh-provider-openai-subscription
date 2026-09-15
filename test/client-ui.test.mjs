/**
 * Browser-half UI contract tests.
 *
 * Loads the hand-written client bundle the way the DSH client module loader
 * would (window.__ModuleLoader__.load handoff), executes its factory with a
 * stubbed module table, and asserts the plugin descriptor, the pure
 * state-derivation surface, and the four slot registrations apply() wires.
 * Only the draggable sidebar indicator is rendered, through a minimal hook
 * runtime that models React's index-keyed state slots and its
 * cleanup-before-next-effect ordering; every other component stays unrendered.
 *
 * @module dsh-provider-openai-subscription/client-ui
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const clientFile = join(dirname(fileURLToPath(import.meta.url)), '..', 'client', 'client.js')
const PANEL_STORE_KEY = 'dsh-provider-openai-subscription.balance-panel'

let captured = null
const storedValues = new Map()
const windowListeners = []
globalThis.window = {
  __ModuleLoader__: {
    load: (registration) => { captured = registration },
  },
  innerWidth: 1000,
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
  // Enough of the CSSOM for the seat lookup: only `display` is read.
  getComputedStyle: (node) => ({ display: node.display === undefined ? 'block' : node.display }),
}

await import(`${pathToFileURL(clientFile).href}`)

assert.notEqual(captured, null, 'bundle must register through window.__ModuleLoader__.load')

/**
 * Minimal hook runtime: index-keyed slots that survive re-renders, plus effects
 * that run only when their dependencies changed — re-running a mount effect on
 * every pass would reset state a test had just staged, which React never does.
 * @returns {object} the runtime `renderOnce` drives.
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
      return [...cleanups.values()]
    },
    cleanups() { return [...cleanups.values()] },
  }
}

let hooks = createHookRuntime()

const reactShim = {
  createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
  useEffect: (fn, deps) => hooks.useEffect(fn, deps),
  useState: (initial) => hooks.useState(initial),
  useCallback: (fn) => fn,
  useRef: (initial) => hooks.useRef(initial),
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

test('pure surface: floating balance panel stays inside the viewport', () => {
  const { clampFloatingPanel } = descriptor.pure
  const viewport = { width: 1000, height: 800 }
  const box = (x, y) => ({ x, y, width: 200, height: 40 })

  assert.deepEqual(clampFloatingPanel(box(120, 300), viewport), box(120, 300), 'an inside box is kept as dragged')
  assert.deepEqual(clampFloatingPanel(box(-40, -90), viewport), box(4, 4), 'dragging past an edge keeps a margin')
  assert.deepEqual(
    clampFloatingPanel(box(5000, 5000), viewport),
    box(796, 756),
    'the right and bottom edges keep the margin too',
  )
  assert.deepEqual(
    clampFloatingPanel(box(300, 300), { width: 120, height: 30 }),
    box(4, 4),
    'a panel larger than the viewport pins to the top-left margin',
  )
  assert.deepEqual(clampFloatingPanel(box(10, 10), { width: 0, height: 0 }), box(4, 4), 'an unknown viewport falls back to the margin')
})

test('pure surface: floating panel moves to the nearest unoccupied position', () => {
  const { avoidPanelCollisions } = descriptor.pure
  const viewport = { width: 1000, height: 800 }
  const panel = { x: 400, y: 300, width: 200, height: 40 }

  assert.deepEqual(avoidPanelCollisions(panel, [], viewport), panel, 'an empty position stays unchanged')
  assert.deepEqual(
    avoidPanelCollisions(panel, [{ x: 390, y: 290, width: 220, height: 60 }], viewport),
    { ...panel, y: 242 },
    'an occupied position picks the nearest free side',
  )
  assert.deepEqual(
    avoidPanelCollisions(panel, [
      { x: 390, y: 290, width: 220, height: 60 },
      { x: 390, y: 220, width: 220, height: 60 },
    ], viewport),
    { ...panel, y: 358 },
    'a blocked first candidate uses another free side',
  )
})

test('pure surface: a persisted panel box round-trips or is rejected', () => {
  const { parseStoredPanel } = descriptor.pure
  const stored = { x: 12, y: 34, width: 180, height: 36 }

  assert.deepEqual(parseStoredPanel(JSON.stringify(stored)), stored)
  assert.deepEqual(parseStoredPanel(JSON.stringify({ ...stored, x: -5 })), { ...stored, x: -5 }, 'clamping happens at read time, not here')
  assert.equal(parseStoredPanel(null), null)
  assert.equal(parseStoredPanel(''), null)
  assert.equal(parseStoredPanel('{'), null, 'truncated JSON is not a position')
  assert.equal(parseStoredPanel('[12,34]'), null, 'a non-object payload is not a position')
  assert.equal(parseStoredPanel('{"x":12,"y":34,"width":180}'), null, 'a partial box is not a position')
  assert.equal(parseStoredPanel('{"x":12,"y":34,"width":"180","height":36}'), null, 'a non-numeric edge is not a position')
  assert.equal(parseStoredPanel('{"x":12,"y":34,"width":0,"height":36}'), null, 'a zero-width box is not a position')
  assert.equal(parseStoredPanel('{"x":12,"y":34,"width":180,"height":null}'), null, 'a null height is not a position')
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
    ['settings.section', 'settings.onboarding', 'sidebar.footer.action', 'conversation.composer.dock'],
    'apply must wire the settings section, the onboarding step, the sidebar action and the session dock',
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

  const sidebar = bySlot('sidebar.footer.action')
  assert.equal(sidebar.length, 1)
  assert.equal(sidebar[0].options.id, 'dsh-provider-openai-subscription-balance')

  const dock = bySlot('conversation.composer.dock')
  assert.equal(dock.length, 1)
  assert.equal(dock[0].options.id, 'dsh-provider-openai-subscription-usage')
  assert.equal(dock[0].options.order, 6)

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

/**
 * Capture the sidebar indicator apply() registers, together with the fake
 * services that make it resolve the plugin's own provider.
 * @returns {{component: Function, props: object}} the component and its props.
 */
function sidebarIndicator() {
  let component = null
  const sessionsService = {
    list: { getSnapshot: () => ({ current: 's1' }), subscribe: () => () => {} },
  }
  const modelDirectories = {
    directoryFor: () => ({ store: { getSnapshot: () => ({ current: { provider: 'openai-subscription' } }) } }),
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
  return { component, props: { sessionsService, modelDirectories, getLocale: () => undefined } }
}

test('sidebar indicator drags into a floating panel and remembers where', async () => {
  const { component, props } = sidebarIndicator()
  assert.equal(typeof component, 'function')
  const runtimes = [hooks]

  // Models the committed DOM node: docked, the indicator is the sidebar's
  // 200px-wide button; floating, it sizes to its own text. The seat mirrors the
  // real DOM — a `display: contents` slot wrapper inside the flex row that
  // dsh-cost-meter also occupies.
  let committed = null
  const seat = { style: { flexWrap: '' }, parentElement: null, display: 'flex' }
  const slotWrapper = { style: {}, parentElement: seat, display: 'contents', children: [] }
  const domNode = {
    parentElement: slotWrapper,
    getBoundingClientRect: () => {
      const style = committed === null ? {} : committed.props.style
      const isFloating = style.position === 'fixed'
      return {
        left: isFloating ? style.left : 10,
        top: isFloating ? style.top : 660,
        width: isFloating ? 260 : 200,
        height: 30,
      }
    },
    setPointerCapture: () => {},
  }
  /** The indicator's own button, found inside the element that wraps it. */
  const buttonOf = (tree) => {
    if (tree === null || typeof tree !== 'object') return null
    if (tree.type === 'button') return tree
    const children = Array.isArray(tree.children) ? tree.children.flat(Infinity) : []
    return children.find((child) => child !== null && typeof child === 'object' && child.type === 'button') ?? null
  }

  const renderOnce = () => {    hooks.begin()
    const node = component(props)
    committed = buttonOf(node)
    const ref = node === null ? null : buttonOf(node).props.ref
    if (typeof ref === 'function') ref(domNode)
    else if (ref !== null && ref !== undefined) ref.current = domNode
    hooks.drain()
    return node
  }
  const pointer = (overrides) => ({ preventDefault: () => {}, ...overrides })
  const anchor = domNode

  try {
    renderOnce()
    let node = renderOnce()
    assert.equal(buttonOf(node).type, 'button', 'the indicator renders once the provider is known')
    assert.equal(buttonOf(node).props.style.position, undefined, 'it starts docked in the sidebar foot')
    assert.equal(buttonOf(node).props.style.flex, '1 1 100%', 'it claims a whole line of the footer seat')
    assert.equal(buttonOf(node).props.style.order, -1, 'its line sorts above the other footer actions')
    assert.equal(buttonOf(node).props.style.minWidth, 0, 'the indicator shrinks instead of pushing a neighbour out')
    assert.equal(buttonOf(node).props.style.boxSizing, 'border-box', 'its own padding stays inside the seat')
    assert.equal(buttonOf(node).props.style.textOverflow, 'ellipsis', 'its own text clips before it covers a neighbour')
    assert.equal(buttonOf(node).props.style.cursor, 'grab')
    assert.equal(seat.style.flexWrap, 'wrap', 'the occupied seat is allowed to give the indicator its own line')
    assert.ok(buttonOf(node).props.title.includes('拖动'), 'the tooltip states the drag affordance')

    // The seat shows an icon and the numbers wait for a click: a remote or
    // phone-width sidebar cannot fit them, and a clipped number reads as wrong.
    const flatten = (tree) => (tree !== null && typeof tree === 'object' && Array.isArray(tree.children)
      ? tree.children.flat(Infinity)
      : [])
    const cardOf = (tree) => flatten(tree).find((child) => child !== null && typeof child === 'object' && child.props?.['data-details'] === 'meter')
    const iconsOf = (tree) => {
      const found = []
      const walk = (entry) => {
        if (entry === null || typeof entry !== 'object') return
        if (Array.isArray(entry)) { for (const child of entry) walk(child); return }
        if (entry.type === 'svg') found.push(entry)
        walk(entry.children)
      }
      walk(tree)
      return found
    }
    const textOfTree = (tree) => {
      if (tree === null || tree === undefined || typeof tree === 'boolean') return ''
      if (typeof tree === 'string' || typeof tree === 'number') return String(tree)
      if (Array.isArray(tree)) return tree.map(textOfTree).join(' ')
      if (typeof tree !== 'object') return ''
      return textOfTree(tree.children)
    }

    const desktop = buttonOf(node)
    assert.ok(textOfTree(desktop).trim().length > 0, 'a desktop window shows the numbers themselves')
    assert.equal(iconsOf(desktop.children ?? desktop).length, 0, 'and no icon in their place')
    assert.equal(cardOf(node), undefined, 'the card starts hidden')

    buttonOf(node).props.onPointerDown(pointer({ button: 0, pointerId: 1, clientX: 100, clientY: 680, currentTarget: anchor }))
    buttonOf(node).props.onPointerMove(pointer({ pointerId: 1, clientX: 102, clientY: 681, currentTarget: anchor }))
    node = renderOnce()
    assert.equal(buttonOf(node).props.style.position, undefined, 'a press below the threshold stays a click')

    buttonOf(node).props.onPointerMove(pointer({ pointerId: 1, clientX: 400, clientY: 380, currentTarget: anchor }))
    node = renderOnce()
    assert.equal(buttonOf(node).props.style.position, 'fixed', 'a real drag detaches the indicator')
    assert.equal(buttonOf(node).props.style.left, 310)
    assert.equal(buttonOf(node).props.style.top, 360)
    assert.equal(buttonOf(node).props.style.width, undefined, 'the floating panel sizes to its own text, not the sidebar width')
    assert.equal(buttonOf(node).props.style.whiteSpace, 'nowrap')
    assert.equal(buttonOf(node).props.style.maxWidth, 992, 'only a viewport narrower than the text can trim it')
    assert.equal(buttonOf(node).props.style.cursor, 'grabbing')
    assert.equal(seat.style.flexWrap, '', 'the seat keeps its own layout once the indicator floats away')

    buttonOf(node).props.onPointerMove(pointer({ pointerId: 1, clientX: 5000, clientY: 5000, currentTarget: anchor }))
    node = renderOnce()
    assert.equal(buttonOf(node).props.style.left, 736, 'the right edge clamps against the measured floating width')
    assert.equal(buttonOf(node).props.style.top, 766, 'the bottom edge clamps')

    buttonOf(node).props.onPointerUp(pointer({ pointerId: 1 }))
    node = renderOnce()
    assert.equal(buttonOf(node).props.style.cursor, 'grab', 'releasing restores the grab cursor')

    await new Promise((resolve) => { setTimeout(resolve, 260) })
    assert.deepEqual(
      JSON.parse(storedValues.get(PANEL_STORE_KEY)),
      { x: 736, y: 766, width: 260, height: 30 },
      'the settled position and measured size are stored',
    )

    // A fresh mount restores the stored position, re-measured and clamped.
    storedValues.set(PANEL_STORE_KEY, JSON.stringify({ x: 990, y: 900, width: 200, height: 30 }))
    hooks = createHookRuntime()
    runtimes.push(hooks)
    renderOnce()
    node = renderOnce()
    // The mount effect re-measures the floating panel and updates state; that
    // update lands on the next render, exactly as it would under React.
    node = renderOnce()
    assert.equal(buttonOf(node).props.style.position, 'fixed', 'a stored position restores as a floating panel')
    assert.equal(buttonOf(node).props.style.left, 736, 'restoring re-clamps against the panel it actually renders')
    assert.equal(buttonOf(node).props.style.top, 766)

    buttonOf(node).props.onDoubleClick()
    node = renderOnce()
    assert.equal(buttonOf(node).props.style.position, undefined, 'a double click docks the panel again')
    await new Promise((resolve) => { setTimeout(resolve, 260) })
    assert.equal(storedValues.has(PANEL_STORE_KEY), false, 'docking drops the stored position')

    // A shrinking window pulls a floating panel back into view.
    buttonOf(node).props.onPointerDown(pointer({ button: 0, pointerId: 2, clientX: 100, clientY: 680, currentTarget: anchor }))
    buttonOf(node).props.onPointerMove(pointer({ pointerId: 2, clientX: 400, clientY: 380, currentTarget: anchor }))
    node = renderOnce()
    assert.equal(buttonOf(node).props.style.left, 310)
    window.innerWidth = 320
    const resizeListeners = windowListeners.filter((entry) => entry.type === 'resize')
    assert.ok(resizeListeners.length > 0, 'a resize listener must be registered')
    for (const entry of resizeListeners) entry.listener()
    node = renderOnce()
    assert.equal(buttonOf(node).props.style.left, 56, 'the shrunk viewport clamps the panel back inside')

    // A phone-width viewport swaps the numbers for an icon: they cannot fit, so
    // they wait behind a click and then wrap inside the viewport. Release the
    // pointer first: a press that moved is a drag, and a drag must not toggle.
    buttonOf(node).props.onPointerUp(pointer({ pointerId: 2 }))
    node = renderOnce()
    assert.equal(window.innerWidth, 320)
    const narrowButton = buttonOf(node)
    assert.equal(textOfTree(narrowButton).trim(), '', 'a narrow viewport renders no text to overflow')
    assert.equal(iconsOf(narrowButton.children ?? narrowButton).length, 1, 'it renders the icon instead')
    assert.equal(cardOf(node), undefined, 'and still hides the data until asked')

    narrowButton.props.onClick()
    node = renderOnce()
    const narrowCard = cardOf(node)
    assert.notEqual(narrowCard, undefined, 'clicking the icon reveals the data on a narrow viewport too')
    assert.ok(textOfTree(narrowCard).trim().length > 0, 'the card carries the numbers')
    assert.equal(narrowCard.props.style.whiteSpace, 'normal', 'and wraps instead of clipping')
    assert.ok(Number(narrowCard.props.style.width) <= window.innerWidth, 'never exceeding the viewport')

    buttonOf(node).props.onClick()
    node = renderOnce()
    assert.equal(cardOf(node), undefined, 'clicking again hides it')

    // Widening the window brings the numbers back without a reload.
    window.innerWidth = 1000
    for (const entry of windowListeners.filter((listener) => listener.type === 'resize')) entry.listener()
    node = renderOnce()
    assert.ok(textOfTree(buttonOf(node)).trim().length > 0, 'a wide viewport shows the numbers again')
  } finally {
    window.innerWidth = 1000
    // Every mount left a poll interval behind; the remount's runtime is a
    // different one, so both must be torn down.
    for (const runtime of runtimes) {
      for (const cleanup of runtime.cleanups()) if (typeof cleanup === 'function') cleanup()
    }
  }
})
