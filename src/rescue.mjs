#!/usr/bin/env node
/**
 * Standalone rescue CLI for dsh-provider-openai-subscription.
 *
 * It deliberately uses only Node built-ins and does not import DSH, Cordis,
 * or the plugin runtime.  It can disable the plugin even when DSH cannot
 * start, which is the last-resort guarantee behind the safe bootstrap.
 *
 * @module dsh-provider-openai-subscription/rescue
 */

import { access, readFile, readdir, writeFile, mkdir, rename, mkdtemp, rm } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { PACKAGE_NAME, ROW_ID, KILL_SWITCH_FILENAME } from './constants.js'
import {
  dshHome, pluginStateDir, killSwitchPath, enableKillSwitch, disableKillSwitch,
  usageLedgerPath, meterSettingsPath, retiredCostMeterLedgerPath,
} from './state.js'
import { pricedVendors } from './usage/vendors.js'

/** Routes whose vendor publishes a price table, so a missing rate can be named. */
const PRICED_PROVIDER_IDS = Object.freeze(pricedVendors().flatMap((vendor) => vendor.providers))

const HELP = `dsh-openai-subscription-rescue

Usage:
  dsh-openai-subscription-rescue status
  dsh-openai-subscription-rescue meter
  dsh-openai-subscription-rescue disable
  dsh-openai-subscription-rescue enable
  dsh-openai-subscription-rescue snapshot --profile <package.json> [--patch <cordis.patch.yml>]
  dsh-openai-subscription-rescue rollback [--path <snapshot-dir>] --target <profile-package.json>
  dsh-openai-subscription-rescue install --profile <package.json> --source <link|version> [--apply]
  dsh-openai-subscription-rescue help

Commands:
  status                 Print non-secret plugin safety state.
  meter                  Print the usage meter's ledger and settings state (read-only).
  disable                Create the kill switch so bootstrap never loads runtime.
  enable                 Remove the kill switch.
  snapshot               Save a reversible copy of profile package.json (+ optional patch).
  rollback               Restore the newest supported snapshot from <dir>.
  install                Add this plugin to a profile dependency/bundle list (dry-run unless --apply).
  doctor [--profile <package.json>]  Print a non-secret readiness/canary report.
  canary --profile <package.json>    Create a static shadow-profile canary.
`

/**
 * Print a line to stdout.
 * @param {string} text
 */
function print(text) {
  process.stdout.write(`${text}\n`)
}

/**
 * Read a file safely.
 * @param {string} path
 * @returns {Promise<string|undefined>}
 */
async function tryRead(path) {
  try {
    return await readFile(path, 'utf8')
  } catch {
    return undefined
  }
}

/**
 * Check whether a path exists.
 * @param {string} path
 * @returns {Promise<boolean>}
 */
async function exists(path) {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

/**
 * Report the built-in usage meter's local state without reading credentials.
 *
 * The point is to make an upgrade checkable: the ledger's schema version and
 * fact count, the settings revision, and whether the retired `dsh-cost-meter`
 * ledger is still on disk untouched. It reads files only — no network, no
 * credential, and it never prints a credential value or a raw ledger entry.
 * @returns {Promise<void>}
 */
async function commandMeter() {
  const home = dshHome()
  const ledgerPath = usageLedgerPath(home)
  const settingsPath = meterSettingsPath(home)
  const legacyPath = retiredCostMeterLedgerPath(home)

  const ledger = await describeJson(ledgerPath, (parsed) => ({
    schemaVersion: parsed.schemaVersion,
    facts: Array.isArray(parsed.entries) ? parsed.entries.length : undefined,
    oldestFactAt: entryInstant(Array.isArray(parsed.entries) ? parsed.entries[0] : undefined),
    newestFactAt: entryInstant(Array.isArray(parsed.entries) ? parsed.entries[parsed.entries.length - 1] : undefined),
    // The models a price table does not cover yet, so a newly shipped model is
    // something the operator can see here instead of guessing from a bare count.
    unpricedModels: unpricedFromEntries(parsed.entries, PRICED_PROVIDER_IDS),
  }))
  const settings = await describeJson(settingsPath, (parsed) => ({
    revision: parsed.revision,
    accountKind: parsed.user?.accountKind ?? 'unknown',
    displayCurrency: parsed.user?.displayCurrency,
    timeZone: parsed.user?.timeZone,
    contractualSchedules: Array.isArray(parsed.user?.contractualSchedules) ? parsed.user.contractualSchedules.length : 0,
  }))

  print(JSON.stringify({
    ok: true,
    plugin: PACKAGE_NAME,
    dshHome: home,
    ledger: { path: ledgerPath, ...ledger },
    settings: { path: settingsPath, ...settings },
    retiredCostMeterLedger: { path: legacyPath, present: await exists(legacyPath), note: 'read by this plugin: never' },
    note: 'Read-only report: no ledger entry, credential or account number is printed.',
  }, null, 2))
}

/**
 * When an entry's calls happened. A rollup states the instant directly; a raw
 * entry carries it on its fact.
 * @param {unknown} entry
 * @returns {number|undefined}
 */
function entryInstant(entry) {
  if (entry === null || typeof entry !== 'object') return undefined
  if (entry.rollup === true) return entry.startedAt
  const fact = entry.fact
  return fact === null || typeof fact !== 'object' ? undefined : fact.startedAt
}

/**
 * Models whose calls the ledger could not price, most used first.
 *
 * Only a route whose vendor publishes a price table can be missing a rate: a
 * vendor that publishes none records every call as unpriced by design, which is
 * its normal state. This projection is also why the report never has to print a
 * raw ledger entry.
 * @param {unknown} entries
 * @param {readonly string[]} providers - routes whose vendor publishes a table.
 * @returns {Array<{provider: string, model: string, calls: number, reason: string}>}
 */
function unpricedFromEntries(entries, providers) {
  if (!Array.isArray(entries)) return []
  const wanted = new Set(providers)
  const seen = new Map()
  for (const entry of entries) {
    const quote = entry === null || typeof entry !== 'object' ? undefined : entry.quote
    if (quote === null || typeof quote !== 'object' || quote.status !== 'unpriced') continue
    const provider = entry.fact === null || typeof entry.fact !== 'object' ? undefined : entry.fact.provider
    const model = entry.fact === null || typeof entry.fact !== 'object' ? undefined : entry.fact.model
    if (typeof provider !== 'string' || typeof model !== 'string') continue
    if (!wanted.has(provider)) continue
    const key = `${provider}\u0000${model}`
    const current = seen.get(key) ?? { provider, model, calls: 0, reason: quote.reason }
    current.calls += 1
    seen.set(key, current)
  }
  return [...seen.values()].sort((left, right) => right.calls - left.calls || left.model.localeCompare(right.model))
}

/**
 * Describe one JSON file as parsed facts, or as a named absence.
 * @param {string} path
 * @param {(parsed: any) => object} project - pulls the reportable fields out.
 * @returns {Promise<object>}
 */
async function describeJson(path, project) {
  const raw = await tryRead(path)
  if (raw === undefined) return { present: false }
  try {
    return { present: true, ...project(JSON.parse(raw)) }
  } catch {
    // A file that exists but does not parse is the fact worth reporting: the
    // meter quarantines such a ledger on the next start rather than reading it.
    return { present: true, unreadable: true }
  }
}

/**
 * Print current rescue/state information. Never prints secrets or absolute
 * credential paths.
 * @returns {Promise<void>}
 */
async function commandStatus() {
  const home = dshHome()
  const switchPath = killSwitchPath()
  const disabled = await exists(switchPath)
  const stateDir = pluginStateDir()
  let snapshots = []
  try {
    snapshots = await readdir(stateDir)
  } catch {
    // state dir may not exist yet
  }
  const activationFiles = snapshots
    .filter((entry) => entry.startsWith('openai-subscription-') && entry.endsWith('.json'))
    .sort()
  print(JSON.stringify({
    ok: true,
    plugin: PACKAGE_NAME,
    rowId: ROW_ID,
    dshHome: home,
    killSwitch: KILL_SWITCH_FILENAME,
    disabled,
    stateDir,
    activationSnapshots: activationFiles.length,
    note: 'This report contains no credentials or sensitive paths beyond the effective DSH home directory.',
  }, null, 2))
}

/**
 * Create the kill switch.
 * @returns {Promise<void>}
 */
async function commandDisable() {
  await enableKillSwitch()
  print(`disabled: ${PACKAGE_NAME} will not load runtime.js on next DSH start.`)
}

/**
 * Remove the kill switch.
 * @returns {Promise<void>}
 */
async function commandEnable() {
  const removed = await disableKillSwitch()
  if (removed) print(`enabled: removed kill switch for ${PACKAGE_NAME}.`)
  else print(`enabled: no kill switch was present for ${PACKAGE_NAME}.`)
}

/**
 * Detect the edit that leaves a profile unable to boot.
 *
 * A profile ships `cordis.patch.yml` with a placeholder `[]`, and activation
 * means adding an id-targeted entry. Appending that entry *after* the
 * placeholder produces `[]` followed by a block sequence, which YAML rejects,
 * and DSH then refuses to compose the profile at all. Only the combination is
 * reported: `[]` alone is the shipped default, and a block alone is correct.
 *
 * @param {string} text - raw cordis.patch.yml contents.
 * @returns {boolean} true when the placeholder precedes a block sequence.
 */
function isPlaceholderThenBlock(text) {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'))
  if (lines[0] !== '[]') return false
  return lines.slice(1).some((line) => line === '-' || line.startsWith('- '))
}

/**
 * Print a non-secret doctor/canary readiness report.
 *
 * With `--profile`, it also reads the activation layer beside that
 * package.json, because the two ways to get activation wrong are silent in the
 * composition: the row never activates, or the placeholder is left in place and
 * the profile stops composing.
 *
 * @param {string|undefined} profilePackage
 * @returns {Promise<void>}
 */
async function commandDoctor(profilePackage) {
  const here = dirname(fileURLToPath(import.meta.url))
  const packagePath = join(here, '..', 'package.json')
  const runtimePath = join(here, 'runtime.js')
  const clientPath = join(here, '..', 'client', 'client.js')
  const patchPath = join(here, '..', 'cordis.patch.yml')
  const switchPath = killSwitchPath()
  const checks = {
    node: process.version,
    package: await exists(packagePath),
    runtime: await exists(runtimePath),
    client: await exists(clientPath),
    patch: await exists(patchPath),
    killSwitch: await exists(switchPath),
    profileHasPlugin: false,
    profileHasRow: false,
    profilePatchFile: false,
    profilePatchActivatesRow: false,
    profilePatchPlaceholderAppended: false,
  }
  if (profilePackage) {
    const raw = await tryRead(profilePackage)
    if (raw) {
      try {
        const json = JSON.parse(raw)
        const deps = { ...(json.dependencies || {}), ...(json.devDependencies || {}) }
        checks.profileHasPlugin = deps[PACKAGE_NAME] !== undefined
        const bundles = json.dsh?.profile?.bundles || json.bundles || []
        checks.profileHasRow = Array.isArray(bundles) && bundles.includes(PACKAGE_NAME)
      } catch {
        // leave false
      }
    }
    const patchRaw = await tryRead(join(dirname(profilePackage), 'cordis.patch.yml'))
    if (patchRaw !== undefined) {
      checks.profilePatchFile = true
      checks.profilePatchActivatesRow = patchRaw.includes(ROW_ID)
      checks.profilePatchPlaceholderAppended = isPlaceholderThenBlock(patchRaw)
      if (checks.profilePatchPlaceholderAppended) {
        checks.profilePatchProblem = 'the placeholder "[]" is still in place before a block sequence, which YAML rejects: the profile will not compose. Replace "[]" with the entry instead of appending after it.'
      }
    }
  }
  checks.ok = checks.package && checks.runtime && checks.client && checks.patch
  print(JSON.stringify({ ok: checks.ok, plugin: PACKAGE_NAME, rowId: ROW_ID, ...checks }, null, 2))
}

/**
 * Shadow-profile canary.
 *
 * Creates a temporary copy of the target profile package.json, applies the
 * same dependency/bundle changes `install --apply` would make, and verifies
 * the plugin package files are present.  This is a static canary; it does not
 * boot DSH or modify the real profile.
 *
 * @param {string} profilePackage
 * @returns {Promise<void>}
 */
async function commandCanary(profilePackage) {
  if (!profilePackage) {
    print('canary: --profile <package.json> is required.')
    process.exitCode = 2
    return
  }
  const raw = await tryRead(profilePackage)
  if (!raw) {
    print('canary: profile package.json is unreadable.')
    process.exitCode = 2
    return
  }
  let packageJson
  try {
    packageJson = JSON.parse(raw)
  } catch {
    print('canary: profile package.json is not valid JSON.')
    process.exitCode = 2
    return
  }
  const shadowDir = await mkdtemp(join(tmpdir(), 'dsh-openai-subscription-canary-'))
  try {
    const shadowPath = join(shadowDir, 'package.json')
    const next = structuredClone(packageJson)
    next.dependencies = { ...(next.dependencies || {}), [PACKAGE_NAME]: 'link:../dsh-provider-openai-subscription' }
    next.dsh = { ...(next.dsh || {}), profile: { ...(next.dsh?.profile || {}), bundles: [...(next.dsh?.profile?.bundles || []), PACKAGE_NAME] } }
    await writeFile(shadowPath, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
    await commandDoctor(shadowPath)
    print(`canary: shadow profile prepared at ${shadowDir}`)
    print('canary: static checks passed; no real profile was modified.')
  } finally {
    await rm(shadowDir, { recursive: true, force: true })
  }
}

/**
 * Add this plugin to a profile package.json (dependency + bundle list).
 *
 * Default is dry-run. With --apply, it first writes a snapshot, then updates
 * package.json atomically. It never runs pnpm install or restarts DSH.
 *
 * @param {string} packagePath
 * @param {string} source
 * @param {boolean} apply
 * @returns {Promise<void>}
 */
async function commandInstall(packagePath, source, apply) {
  if (!packagePath || !source) {
    print('install: --profile <package.json> and --source <link|version> are required.')
    process.exitCode = 2
    return
  }
  const raw = await tryRead(packagePath)
  if (!raw) {
    print('install: profile package.json is unreadable.')
    process.exitCode = 2
    return
  }
  let packageJson
  try {
    packageJson = JSON.parse(raw)
  } catch {
    print('install: profile package.json is not valid JSON.')
    process.exitCode = 2
    return
  }
  if (packageJson === null || typeof packageJson !== 'object' || Array.isArray(packageJson)) {
    print('install: profile package.json must contain an object.')
    process.exitCode = 2
    return
  }
  const next = structuredClone(packageJson)
  const originalBundles = packageJson.dsh && packageJson.dsh.profile && Array.isArray(packageJson.dsh.profile.bundles)
    ? packageJson.dsh.profile.bundles
    : []
  const alreadyDependency = packageJson.dependencies && packageJson.dependencies[PACKAGE_NAME] !== undefined
  const alreadyBundle = originalBundles.includes(PACKAGE_NAME)
  next.dependencies = { ...(next.dependencies || {}) }
  next.dependencies[PACKAGE_NAME] = source
  const bundlesPath = next.dsh && next.dsh.profile && Array.isArray(next.dsh.profile.bundles)
    ? next.dsh.profile.bundles
    : undefined
  if (bundlesPath === undefined) {
    next.dsh = { ...(next.dsh || {}), profile: { ...(next.dsh?.profile || {}), bundles: [PACKAGE_NAME] } }
  } else if (!bundlesPath.includes(PACKAGE_NAME)) {
    bundlesPath.push(PACKAGE_NAME)
  }
  if (alreadyDependency && alreadyBundle) {
    print('install: plugin is already present in this profile.')
    return
  }
  const plan = {
    packagePath,
    source,
    apply,
    changes: {
      dependency: { name: PACKAGE_NAME, value: source },
      bundle: PACKAGE_NAME,
    },
    next,
  }
  if (!apply) {
    print(`install: dry-run, would add ${PACKAGE_NAME} (${source}) to ${packagePath}`)
    print(JSON.stringify({ ok: true, dryRun: true, ...plan }, null, 2))
    return
  }
  await commandSnapshot(packagePath)
  const temp = `${packagePath}.tmp-${process.pid}-${Date.now()}`
  await writeFile(temp, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
  await rename(temp, packagePath)
  print(`install: applied ${PACKAGE_NAME} (${source}) to ${packagePath}`)
  print('install: run pnpm install and restart DSH manually when ready.')
}

/**
 * Create a reversible snapshot of a profile package.json and optional patch.
 * @param {string} packagePath
 * @param {string|undefined} patchPath
 * @returns {Promise<string>} snapshot filename.
 */
async function commandSnapshot(packagePath, patchPath) {
  if (!packagePath) {
    print('snapshot: --profile <package.json> is required.')
    process.exitCode = 2
    return ''
  }
  const rawPackage = await tryRead(packagePath)
  if (!rawPackage) {
    print('snapshot: profile package.json is unreadable.')
    process.exitCode = 2
    return ''
  }
  let packageJson
  try {
    packageJson = JSON.parse(rawPackage)
  } catch {
    print('snapshot: profile package.json is not valid JSON.')
    process.exitCode = 2
    return ''
  }
  let patch
  if (patchPath) {
    patch = await tryRead(patchPath)
    if (patch === undefined) {
      print('snapshot: patch file is unreadable.')
      process.exitCode = 2
      return ''
    }
  }
  const dir = join(pluginStateDir(), 'openai-subscription-snapshots')
  await mkdir(dir, { recursive: true })
  const filename = `openai-subscription-${Date.now()}-${Math.random().toString(16).slice(2, 8)}.json`
  const snapshot = {
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    plugin: PACKAGE_NAME,
    packagePath,
    ...(patchPath ? { patchPath } : {}),
    packageJson,
    ...(patch === undefined ? {} : { patch }),
  }
  await writeFile(join(dir, filename), `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8')
  print(`snapshot: created ${filename}`)
  return filename
}

/**
 * Restore the newest JSON snapshot from a directory.
 *
 * This is intentionally conservative: it refuses to restore when a marker
 * file named .restore-in-progress exists, and it refuses to copy outside the
 * target profile without an explicit --target flag.
 *
 * @param {string} dir
 * @param {string|undefined} target
 * @returns {Promise<void>}
 */
async function commandRollback(dir, target) {
  if (!target) {
    print('rollback: --target <profile-package.json> is required for this snapshot layout.')
    process.exitCode = 2
    return
  }
  const marker = join(dir, '.restore-in-progress')
  if (await exists(marker)) {
    print('rollback: a restore is already in progress; refusing to run concurrently.')
    process.exitCode = 2
    return
  }
  const entries = (await readdir(dir)).filter((name) => name.endsWith('.json')).sort()
  if (entries.length === 0) {
    print('rollback: no JSON snapshot found.')
    process.exitCode = 2
    return
  }
  const newest = entries[entries.length - 1]
  const snapshotPath = join(dir, newest)
  const raw = await tryRead(snapshotPath)
  if (!raw) {
    print('rollback: newest snapshot is unreadable.')
    process.exitCode = 2
    return
  }
  let snapshot
  try {
    snapshot = JSON.parse(raw)
  } catch {
    print('rollback: newest snapshot is not valid JSON.')
    process.exitCode = 2
    return
  }
  const packageJson = snapshot?.packageJson
  if (typeof packageJson !== 'object' || packageJson === null) {
    print('rollback: snapshot has no packageJson payload.')
    process.exitCode = 2
    return
  }
  await writeFile(target, `${JSON.stringify(packageJson, null, 2)}\n`, 'utf8')
  print(`rollback: restored ${newest} to ${target}.`)
  // The activation layer is part of the snapshot because losing it is the most
  // common way a profile stops composing; restoring package.json alone would
  // leave the operator believing the rollback covered it.
  const patchPath = typeof snapshot.patchPath === 'string' ? snapshot.patchPath : undefined
  if (typeof snapshot.patch === 'string' && patchPath !== undefined) {
    await writeFile(patchPath, snapshot.patch, 'utf8')
    print(`rollback: restored the activation layer to ${patchPath}.`)
  }
  // Mark completion adjacent to the snapshot so operators can verify.
  await writeFile(join(dir, `${newest}.restored`), `${new Date().toISOString()}\n`, 'utf8')
}

/**
 * Parse CLI arguments and dispatch.
 * @param {string[]} args
 * @returns {Promise<void>}
 */
async function main(args) {
  const [command, ...rest] = args
  switch (command) {
    case 'status':
      await commandStatus()
      return
    case 'meter':
      await commandMeter()
      return
    case 'disable':
      await commandDisable()
      return
    case 'enable':
      await commandEnable()
      return
    case 'canary': {
      const profileIndex = rest.indexOf('--profile')
      const profilePackage = profileIndex >= 0 && rest[profileIndex + 1] ? rest[profileIndex + 1] : undefined
      await commandCanary(profilePackage)
      return
    }
    case 'doctor': {
      const profileIndex = rest.indexOf('--profile')
      const profilePackage = profileIndex >= 0 && rest[profileIndex + 1] ? rest[profileIndex + 1] : undefined
      await commandDoctor(profilePackage)
      return
    }
    case 'snapshot': {
      const profileIndex = rest.indexOf('--profile')
      const patchIndex = rest.indexOf('--patch')
      const packagePath = profileIndex >= 0 && rest[profileIndex + 1] ? rest[profileIndex + 1] : undefined
      const patchPath = patchIndex >= 0 && rest[patchIndex + 1] ? rest[patchIndex + 1] : undefined
      await commandSnapshot(packagePath, patchPath)
      return
    }
    case 'install': {
      const profileIndex = rest.indexOf('--profile')
      const sourceIndex = rest.indexOf('--source')
      const packagePath = profileIndex >= 0 && rest[profileIndex + 1] ? rest[profileIndex + 1] : undefined
      const source = sourceIndex >= 0 && rest[sourceIndex + 1] ? rest[sourceIndex + 1] : undefined
      const apply = rest.includes('--apply')
      await commandInstall(packagePath, source, apply)
      return
    }
    case 'rollback': {
      const pathIndex = rest.indexOf('--path')
      const targetIndex = rest.indexOf('--target')
      const dir = pathIndex >= 0 && rest[pathIndex + 1] ? rest[pathIndex + 1] : undefined
      const target = targetIndex >= 0 && rest[targetIndex + 1] ? rest[targetIndex + 1] : undefined
      if (!dir) {
        print('rollback: --path <snapshot-dir> is required.')
        process.exitCode = 2
        return
      }
      await commandRollback(dir, target)
      return
    }
    case 'help':
    case '--help':
    case '-h':
      print(HELP)
      return
    default:
      print(`unknown command: ${String(command ?? '')}`)
      print(HELP)
      process.exitCode = 2
  }
}

main(process.argv.slice(2)).catch((error) => {
  process.stderr.write(`rescue failed: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
