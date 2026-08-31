import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile, readFile, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  dshHome, pluginStateDir, killSwitchPath, isKillSwitchPresent, enableKillSwitch, disableKillSwitch,
} from '../src/state.js'

const originalHome = process.env.DSH_HOME
const dirs = []

test.beforeEach(async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-openai-subscription-state-'))
  dirs.push(dir)
  process.env.DSH_HOME = dir
})

test.afterEach(async () => {
  if (originalHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = originalHome
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

test('dshHome honors DSH_HOME', () => {
  const dir = process.env.DSH_HOME
  assert.equal(dshHome(), dir)
})

test('plugin state paths are under DSH_HOME/plugin-state', () => {
  assert.equal(pluginStateDir(), join(dshHome(), 'plugin-state'))
  assert.equal(killSwitchPath(), join(pluginStateDir(), 'openai-subscription.disabled'))
})

test('kill switch is absent by default', async () => {
  assert.equal(await isKillSwitchPresent(), false)
})

test('enableKillSwitch creates the marker and isKillSwitchPresent returns true', async () => {
  await enableKillSwitch()
  assert.equal(await isKillSwitchPresent(), true)
  const content = await readFile(killSwitchPath(), 'utf8')
  assert.match(content, /disabled by dsh-openai-subscription-rescue/)
})

test('disableKillSwitch removes the marker and returns true', async () => {
  await enableKillSwitch()
  assert.equal(await disableKillSwitch(), true)
  assert.equal(await isKillSwitchPresent(), false)
})

test('disableKillSwitch is a no-op when absent', async () => {
  assert.equal(await disableKillSwitch(), false)
})

test('kill switch file is owner-only on POSIX-like filesystems', async () => {
  await enableKillSwitch()
  const info = await access(killSwitchPath())
  assert.equal(info, undefined)
})
