/**
 * Shared test helpers.
 *
 * The file is deliberately not named `*.test.mjs`: the runner's glob only picks
 * test files, so this module is import-only.
 *
 * @module dsh-provider-openai-subscription/test/helpers
 */

/**
 * Minimal hook runtime for rendering the client's components outside React:
 * index-keyed state slots that survive re-renders, plus effects that run only
 * when their dependencies changed — re-running a mount effect on every pass
 * would reset state a test had just staged, which React never does. A slot's
 * cleanup runs before that slot's next effect, matching React's ordering.
 * @returns {object}
 */
export function createHookRuntime() {
  let cursor = 0
  const slots = []
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
