/**
 * Locate packages the running deployment provides.
 *
 * This plugin is installed from a local path (`link:`), so its real module path
 * lives outside the profile. A bare specifier imported from here therefore walks
 * up a directory tree that never contains the harness's own packages, and the
 * walk cannot be fixed by moving this file: the profile is what holds them.
 *
 * The anchors below are tried in order instead, each as a real file URL so
 * `createRequire` can walk up from it:
 *
 * - this module's own path, which covers a plugin installed *into* a profile;
 * - the shared `profiles/node_modules`, then a profile's own `node_modules`,
 *   then the harness home's — the npm layout of an installed harness;
 * - the packaged Desktop layout, whose runtime lives inside `resources/app.asar`
 *   and has no `node_modules` on disk at all. Electron reads asar paths
 *   transparently, so the anchor resolves for the process that needs it and
 *   simply misses under a plain Node runtime.
 *
 * Both callers treat a miss as an ordinary answer: attribution falls back to its
 * own identity, and the config schema falls back to the built-in Standard
 * Schema. Nothing here is a hard dependency.
 *
 * @module dsh-provider-openai-subscription/dsh-modules
 */

import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

/**
 * Resolution anchors for harness-provided packages, nearest first.
 * @returns {Generator<string>} `createRequire` anchors to try in order.
 */
export function* resolutionAnchors() {
  yield import.meta.url
  const configured = process.env.DSH_HOME
  const home = configured !== undefined && configured.length > 0 ? configured : join(homedir(), '.dsh')
  for (const relative of ['profiles/node_modules', 'profiles/web/node_modules', 'node_modules']) {
    yield pathToFileURL(join(home, relative, 'noop.js')).href
  }
  // The packaged layouts. The Desktop's own runtime lives inside `app.asar`, and
  // Electron's `require` reads asar paths transparently — but only where the
  // archive really is, so `process.resourcesPath` (Electron's own answer) is
  // tried before the harness home's guess.
  const resources = process.resourcesPath
  if (typeof resources === 'string' && resources.length > 0) {
    yield pathToFileURL(join(resources, 'app.asar', 'dsh', 'node_modules', 'noop.js')).href
  }
  yield pathToFileURL(join(home, 'resources', 'app.asar', 'dsh', 'node_modules', 'noop.js')).href
  yield pathToFileURL(join(home, 'resources', 'app.asar.unpacked', 'dsh', 'node_modules', 'noop.js')).href
}

/**
 * Resolve a harness-provided package without importing it.
 * @param {string} specifier - the bare specifier to resolve.
 * @returns {string|undefined} the resolved path, or undefined when unreachable.
 */
export function resolveHarnessModule(specifier) {
  for (const anchor of resolutionAnchors()) {
    try {
      return createRequire(anchor).resolve(specifier)
    } catch {
      // Not reachable from this anchor; try the next.
    }
  }
  return undefined
}

/** Entry points to try inside a package whose manifest cannot be read first. */
const PACKAGE_ENTRIES = ['lib/index.mjs', 'lib/index.js', 'lib/index.cjs']

/**
 * URL candidates for a package inside a packaged layout's archive.
 *
 * `createRequire` resolves through the real filesystem, and the packaged Desktop
 * keeps its runtime inside `app.asar` — the walk finds nothing there even though
 * Electron's own loader imports those very files happily. So the archive is
 * addressed directly as a URL, which the runtime that needs it can read.
 *
 * @param {string} specifier - the bare specifier to locate.
 * @returns {string[]} file URLs to try, nearest layout first.
 */
function packagedCandidates(specifier) {
  const roots = []
  if (typeof process.resourcesPath === 'string' && process.resourcesPath.length > 0) {
    roots.push(join(process.resourcesPath, 'app.asar', 'dsh', 'node_modules'))
  }
  const configured = process.env.DSH_HOME
  if (configured !== undefined && configured.length > 0) {
    roots.push(join(configured, 'resources', 'app.asar', 'dsh', 'node_modules'))
    roots.push(join(configured, 'resources', 'app.asar.unpacked', 'dsh', 'node_modules'))
  }
  const candidates = []
  for (const root of roots) {
    for (const entry of PACKAGE_ENTRIES) {
      candidates.push(pathToFileURL(join(root, specifier, entry)).href)
    }
  }
  return candidates
}

/**
 * Import a harness-provided package: resolved through an anchor first, then
 * addressed inside a packaged archive when no anchor can see it.
 *
 * The anchor is kept for the `require`-style resolution rather than re-deriving
 * one from the resolved path, because a package inside an asar archive resolves
 * by a path plain Node cannot stat, and only the anchor that answered knows how
 * to read it.
 *
 * @param {string} specifier - the bare specifier to load.
 * @returns {Promise<unknown>} the loaded module.
 */
export async function loadHarnessModule(specifier) {
  for (const anchor of resolutionAnchors()) {
    let resolved
    try {
      resolved = createRequire(anchor).resolve(specifier)
    } catch {
      continue
    }
    return import(pathToFileURL(resolved).href)
  }
  let problem
  for (const candidate of packagedCandidates(specifier)) {
    try {
      return await import(candidate)
    } catch (error) {
      problem = error
    }
  }
  const reason = problem instanceof Error ? problem.message : String(problem)
  throw new Error(`${specifier} is not reachable from this install (packaged layouts: ${reason})`)
}

/**
 * Require a harness-provided package synchronously, for a load-time need.
 *
 * The failure carries the last anchor's own error: "not reachable" without a
 * reason is unactionable in a packaged layout, where a wrong path and a broken
 * archive look identical from outside.
 *
 * @param {string} specifier - the bare specifier to load.
 * @returns {unknown} the module's exports.
 * @throws {Error} when no anchor reaches it.
 */
export function requireHarnessModule(specifier) {
  let lastAnchor
  let lastError
  for (const anchor of resolutionAnchors()) {
    lastAnchor = anchor
    try {
      return createRequire(anchor)(specifier)
    } catch (error) {
      lastError = error
      // Unreachable from this anchor, or its own load failed; try the next.
    }
  }
  const reason = lastError instanceof Error ? lastError.message : String(lastError)
  throw new Error(`${specifier} is not reachable from this install (last anchor ${String(lastAnchor)}: ${reason})`)
}
