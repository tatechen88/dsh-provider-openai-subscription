/**
 * DSH plugin state filesystem helpers.
 *
 * The kill switch is a marker file that must be checked before runtime.js is
 * loaded.  It contains no secrets and can be created by the standalone rescue
 * CLI even when DSH cannot start.
 *
 * @module dsh-provider-openai-subscription/state
 */

import { access, mkdir, writeFile, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { KILL_SWITCH_FILENAME } from './constants.js'

/**
 * Effective DSH home directory.  The plugin never writes credentials itself;
 * this path is only used for non-secret plugin state and rescue tooling.
 *
 * @returns {string}
 */
export function dshHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh')
}

/**
 * Directory for non-secret plugin state files.
 * @param {string} [home] - DSH home; injectable so callers and tests can aim it.
 * @returns {string}
 */
export function pluginStateDir(home = dshHome()) {
  return join(home, 'plugin-state')
}

/**
 * Absolute path of the usage meter's ledger.
 *
 * The ledger is durable session data, so it lives under `storages/` beside the
 * rest of the DSH data rather than in `plugin-state/`.
 *
 * @param {string} [home] - DSH home; injectable so callers and tests can aim it.
 * @returns {string}
 */
export function usageLedgerPath(home = dshHome()) {
  return join(home, 'storages', 'openai-subscription-meter', 'usage.json')
}

/**
 * Absolute path of the usage meter's settings file.
 * @param {string} [home] - DSH home; injectable so callers and tests can aim it.
 * @returns {string}
 */
export function meterSettingsPath(home = dshHome()) {
  return join(pluginStateDir(home), 'openai-subscription-meter.json')
}

/**
 * Absolute path of the price table learned from the vendor's own price page.
 *
 * Derived data, not a preference: it lives beside the ledger under `storages/`
 * and can be deleted at any time — the built-in snapshot then prices every call
 * again.
 * @param {string} [home] - DSH home; injectable so callers and tests can aim it.
 * @returns {string}
 */
export function learnedPricePath(home = dshHome()) {
  return join(home, 'storages', 'openai-subscription-meter', 'prices.json')
}

/**
 * Absolute path of the retired `dsh-cost-meter` ledger.
 *
 * The migration never reads, imports, or rewrites that file; the rescue CLI
 * reports only whether it is still on disk.
 *
 * @param {string} [home] - DSH home; injectable so callers and tests can aim it.
 * @returns {string}
 */
export function retiredCostMeterLedgerPath(home = dshHome()) {
  return join(home, 'storages', 'cost-meter', 'ledger.json')
}

/**
 * Absolute path of the plugin kill switch marker.
 * @returns {string}
 */
export function killSwitchPath() {
  return join(pluginStateDir(), KILL_SWITCH_FILENAME)
}

/**
 * True when the kill switch marker exists.
 * @returns {Promise<boolean>}
 */
export async function isKillSwitchPresent() {
  try {
    await access(killSwitchPath())
    return true
  } catch {
    return false
  }
}

/**
 * Create the kill switch marker.  The marker is written atomically (temp file
 * + rename) so an interrupted write cannot leave a partial marker.
 * @returns {Promise<void>}
 */
export async function enableKillSwitch() {
  const target = killSwitchPath()
  await mkdir(dirname(target), { recursive: true })
  const temp = `${target}.tmp-${process.pid}-${Date.now()}`
  await writeFile(temp, `disabled by dsh-openai-subscription-rescue at ${new Date().toISOString()}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  })
  const { rename } = await import('node:fs/promises')
  await rename(temp, target)
}

/**
 * Remove the kill switch marker.  Removing an absent marker is a no-op.
 * @returns {Promise<boolean>} true when a marker was removed.
 */
export async function disableKillSwitch() {
  const target = killSwitchPath()
  try {
    await rm(target)
    return true
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return false
    throw error
  }
}
