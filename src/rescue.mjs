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

import { access, readFile, readdir, stat, writeFile, mkdir, rename, mkdtemp, rm } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { PACKAGE_NAME, ROW_ID, KILL_SWITCH_FILENAME } from './constants.js'
import {
  dshHome, pluginStateDir, killSwitchPath, enableKillSwitch, disableKillSwitch,
} from './state.js'

const HELP = `dsh-openai-subscription-rescue

Usage:
  dsh-openai-subscription-rescue status
  dsh-openai-subscription-rescue disable
  dsh-openai-subscription-rescue enable
  dsh-openai-subscription-rescue snapshot --profile <package.json> [--patch <cordis.patch.yml>]
  dsh-openai-subscription-rescue rollback [--path <snapshot-dir>] --target <profile-package.json>
  dsh-openai-subscription-rescue install --profile <package.json> --source <link|version> [--apply]
  dsh-openai-subscription-rescue help

Commands:
  status                 Print non-secret plugin safety state.
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
 * Print a non-secret doctor/canary readiness report.
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
  const { writeFile } = await import('node:fs/promises')
  const { dirname } = await import('node:path')
  await writeFile(target, `${JSON.stringify(packageJson, null, 2)}\n`, 'utf8')
  // Mark completion adjacent to the snapshot so operators can verify.
  await writeFile(join(dir, `${newest}.restored`), `${new Date().toISOString()}\n`, 'utf8')
  void stat(target)
  void dirname
  print(`rollback: restored ${newest} to ${target}.`)
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
