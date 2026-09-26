import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, rm, readFile, access, readdir, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const execFileAsync = promisify(execFile)
const here = dirname(fileURLToPath(import.meta.url))
const rescue = join(here, '..', 'src', 'rescue.mjs')
const dirs = []

test.afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function runRescue(args, env) {
  return execFileAsync(process.execPath, [rescue, ...args], {
    env: { ...process.env, ...env },
    encoding: 'utf8',
  })
}

test('rescue status prints a non-secret JSON report', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-openai-subscription-rescue-'))
  dirs.push(dir)
  const { stdout } = await runRescue(['status'], { DSH_HOME: dir })
  const report = JSON.parse(stdout)
  assert.equal(report.ok, true)
  assert.equal(report.plugin, 'dsh-provider-openai-subscription')
  assert.equal(report.disabled, false)
})

test('rescue disable then status reports disabled', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-openai-subscription-rescue-'))
  dirs.push(dir)
  const env = { DSH_HOME: dir }
  await runRescue(['disable'], env)
  const { stdout } = await runRescue(['status'], env)
  const report = JSON.parse(stdout)
  assert.equal(report.disabled, true)
})

test('rescue enable removes the kill switch', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-openai-subscription-rescue-'))
  dirs.push(dir)
  const env = { DSH_HOME: dir }
  await runRescue(['disable'], env)
  await runRescue(['enable'], env)
  const { stdout } = await runRescue(['status'], env)
  assert.equal(JSON.parse(stdout).disabled, false)
})

test('rescue help exits zero', async () => {
  const { stdout } = await runRescue(['help'], {})
  assert.match(stdout, /Usage:/)
})

test('rescue snapshot creates a JSON snapshot', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-openai-subscription-rescue-'))
  dirs.push(dir)
  const profileDir = await mkdtemp(join(tmpdir(), 'dsh-openai-subscription-profile-'))
  dirs.push(profileDir)
  const packagePath = join(profileDir, 'package.json')
  await writeFile(packagePath, JSON.stringify({ name: 'profile', dependencies: {} }))
  const env = { DSH_HOME: dir }
  const { stdout } = await runRescue(['snapshot', '--profile', packagePath], env)
  assert.match(stdout, /snapshot: created/)
  const snapDir = join(dir, 'plugin-state', 'openai-subscription-snapshots')
  const files = await readdir(snapDir)
  assert.equal(files.length, 1)
  const snap = JSON.parse(await readFile(join(snapDir, files[0]), 'utf8'))
  assert.equal(snap.packageJson.name, 'profile')
})

test('rescue rollback restores snapshot to target', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-openai-subscription-rescue-'))
  dirs.push(dir)
  const profileDir = await mkdtemp(join(tmpdir(), 'dsh-openai-subscription-profile-'))
  dirs.push(profileDir)
  const packagePath = join(profileDir, 'package.json')
  await writeFile(packagePath, JSON.stringify({ name: 'profile', version: '2' }))
  await runRescue(['snapshot', '--profile', packagePath], { DSH_HOME: dir })
  await writeFile(packagePath, JSON.stringify({ name: 'profile', version: '3' }))
  const snapDir = join(dir, 'plugin-state', 'openai-subscription-snapshots')
  await runRescue(['rollback', '--path', snapDir, '--target', packagePath], { DSH_HOME: dir })
  const restored = JSON.parse(await readFile(packagePath, 'utf8'))
  assert.equal(restored.version, '2')
})

test('rescue doctor prints readiness report', async () => {
  const { stdout } = await runRescue(['doctor'], {})
  const report = JSON.parse(stdout)
  assert.equal(report.ok, true)
  assert.equal(report.plugin, 'dsh-provider-openai-subscription')
  assert.equal(report.package, true)
  assert.equal(report.runtime, true)
  // The browser half is gone by design; the report asserts its absence, because
  // a client entry that fails to import is a fatal web-boot failure.
  assert.equal(report.clientFree, true)
  assert.equal('client' in report, false)
})

test('rescue install dry-run does not modify profile', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-openai-subscription-rescue-'))
  dirs.push(dir)
  const profileDir = await mkdtemp(join(tmpdir(), 'dsh-openai-subscription-profile-'))
  dirs.push(profileDir)
  const packagePath = join(profileDir, 'package.json')
  const original = { name: 'profile', dependencies: {} }
  await writeFile(packagePath, JSON.stringify(original))
  const { stdout } = await runRescue(['install', '--profile', packagePath, '--source', 'link:../dsh-provider-openai-subscription'], { DSH_HOME: dir })
  assert.match(stdout, /dry-run/)
  assert.deepEqual(JSON.parse(await readFile(packagePath, 'utf8')), original)
})

test('rescue install --apply updates profile and writes snapshot', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-openai-subscription-rescue-'))
  dirs.push(dir)
  const profileDir = await mkdtemp(join(tmpdir(), 'dsh-openai-subscription-profile-'))
  dirs.push(profileDir)
  const packagePath = join(profileDir, 'package.json')
  await writeFile(packagePath, JSON.stringify({ name: 'profile', dependencies: {} }))
  const { stdout } = await runRescue(['install', '--profile', packagePath, '--source', 'link:../dsh-provider-openai-subscription', '--apply'], { DSH_HOME: dir })
  assert.match(stdout, /install: applied/)
  const updated = JSON.parse(await readFile(packagePath, 'utf8'))
  assert.equal(updated.dependencies['dsh-provider-openai-subscription'], 'link:../dsh-provider-openai-subscription')
  assert.deepEqual(updated.dsh.profile.bundles, ['dsh-provider-openai-subscription'])
  const snapDir = join(dir, 'plugin-state', 'openai-subscription-snapshots')
  const files = await readdir(snapDir)
  assert.equal(files.length, 1)
})

test('rescue canary prepares a static shadow profile', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-openai-subscription-profile-'))
  dirs.push(dir)
  const packagePath = join(dir, 'package.json')
  await writeFile(packagePath, JSON.stringify({ name: 'profile', dependencies: {} }))
  const { stdout } = await runRescue(['canary', '--profile', packagePath], {})
  // The shadow is a scratch copy the command deletes on its way out, and the
  // line must say so: a path that is already gone sends someone hunting for it.
  assert.match(stdout, /shadow profile checked/)
  assert.match(stdout, /removed afterwards/)
  assert.match(stdout, /static checks passed/)
  // Real profile is untouched.
  const after = JSON.parse(await readFile(packagePath, 'utf8'))
  assert.equal(after.dependencies['dsh-provider-openai-subscription'], undefined)
})

test('rescue doctor with profile reports plugin presence', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-openai-subscription-profile-'))
  dirs.push(dir)
  const packagePath = join(dir, 'package.json')
  await writeFile(packagePath, JSON.stringify({ dependencies: { 'dsh-provider-openai-subscription': '0.1.0-alpha.1' } }))
  const { stdout } = await runRescue(['doctor', '--profile', packagePath], {})
  const report = JSON.parse(stdout)
  assert.equal(report.profileHasPlugin, true)
  assert.equal(report.schemaVersion, 1, 'the report carries a version so a consumer can parse it')
})

test('rescue doctor reports the installed DSH against the declared range', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-openai-subscription-profile-'))
  dirs.push(dir)
  const packagePath = join(dir, 'package.json')
  await writeFile(packagePath, JSON.stringify({ dependencies: {} }))
  // A profile whose own node_modules carries the launcher package.
  const launcherDir = join(dir, 'node_modules', '@deepseek-ai', 'dsh')
  await mkdir(launcherDir, { recursive: true })
  await writeFile(join(launcherDir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.1.6-alpha.1' }))

  const { stdout } = await runRescue(['doctor', '--profile', packagePath], {})
  const report = JSON.parse(stdout)
  assert.equal(report.compatibility.installedDsh, '0.1.6-alpha.1')
  assert.equal(report.compatibility.declaredDshRange, '>=0.1.6-alpha.1')
  assert.equal(report.compatibility.satisfied, true)
})

test('rescue doctor calls out a harness older than the declared range', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-openai-subscription-profile-'))
  dirs.push(dir)
  const packagePath = join(dir, 'package.json')
  await writeFile(packagePath, JSON.stringify({ dependencies: {} }))
  const launcherDir = join(dir, 'node_modules', '@deepseek-ai', 'dsh')
  await mkdir(launcherDir, { recursive: true })
  await writeFile(join(launcherDir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.1.5-rc.2' }))

  const { stdout } = await runRescue(['doctor', '--profile', packagePath], {})
  const report = JSON.parse(stdout)
  assert.equal(report.compatibility.installedDsh, '0.1.5-rc.2')
  assert.equal(report.compatibility.satisfied, false, '0.1.5 predates every seam this plugin uses')
})

test('rescue doctor leaves the verdict unknown rather than guessing', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-openai-subscription-profile-'))
  dirs.push(dir)
  const packagePath = join(dir, 'package.json')
  await writeFile(packagePath, JSON.stringify({ dependencies: {} }))
  const { stdout } = await runRescue(['doctor', '--profile', packagePath], { DSH_HOME: dir })
  const report = JSON.parse(stdout)
  assert.equal(report.compatibility.installedDsh, null)
  assert.equal(report.compatibility.satisfied, null, 'an undetectable harness is unknown, never a pass')
})

test('rescue meter reports ledger and settings state without echoing content', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-openai-subscription-rescue-'))
  dirs.push(dir)
  const ledgerDir = join(dir, 'storages', 'openai-subscription-meter')
  const legacyDir = join(dir, 'storages', 'cost-meter')
  const stateDir = join(dir, 'plugin-state')
  await mkdir(ledgerDir, { recursive: true })
  await mkdir(legacyDir, { recursive: true })
  await mkdir(stateDir, { recursive: true })
  const startedAt = 1_760_000_000_000
  await writeFile(join(ledgerDir, 'usage.json'), JSON.stringify({
    schemaVersion: 1,
    updatedAt: startedAt,
    entries: [{ callId: 'SECRET-CALL-ID', fact: { sessionId: 'SECRET-SESSION', startedAt, providerId: 'deepseek-official' } }],
  }))
  await writeFile(join(stateDir, 'openai-subscription-meter.json'), JSON.stringify({
    schemaVersion: 1,
    revision: 5,
    user: {
      accountKind: 'enterprise',
      displayCurrency: 'CNY',
      timeZone: 'Asia/Shanghai',
      contractualSchedules: [{}, {}],
    },
  }))
  await writeFile(join(legacyDir, 'ledger.json'), JSON.stringify({ entries: [{ note: 'SECRET-LEGACY-ENTRY' }] }))

  const { stdout } = await runRescue(['meter'], { DSH_HOME: dir })
  const report = JSON.parse(stdout)
  assert.equal(report.ok, true)
  assert.equal(report.ledger.present, true)
  assert.equal(report.ledger.schemaVersion, 1)
  assert.equal(report.ledger.facts, 1)
  assert.equal(report.ledger.oldestFactAt, startedAt)
  assert.equal(report.ledger.newestFactAt, startedAt)
  assert.equal(report.settings.present, true)
  assert.equal(report.settings.revision, 5)
  assert.equal(report.settings.accountKind, 'enterprise')
  assert.equal(report.settings.contractualSchedules, 2)
  assert.equal(report.retiredCostMeterLedger.present, true)
  // The report is a summary: no entry, call id, or session id is echoed.
  for (const secret of ['SECRET-CALL-ID', 'SECRET-SESSION', 'SECRET-LEGACY-ENTRY']) {
    assert.equal(stdout.includes(secret), false)
  }
})

test('rescue meter names the models the price table does not cover', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-openai-subscription-rescue-'))
  dirs.push(dir)
  const ledgerDir = join(dir, 'storages', 'openai-subscription-meter')
  await mkdir(ledgerDir, { recursive: true })
  const entry = (callId, provider, model, quote) => ({ callId, fact: { provider, model, startedAt: 1 }, quote })
  await writeFile(join(ledgerDir, 'usage.json'), JSON.stringify({
    schemaVersion: 1,
    entries: [
      entry('SECRET-1', 'deepseek-official', 'deepseek-v5', { status: 'unpriced', reason: 'unknown-model' }),
      entry('SECRET-2', 'deepseek-official', 'deepseek-v5', { status: 'unpriced', reason: 'unknown-model' }),
      entry('SECRET-3', 'zai-coding-cn', 'glm-5.3', { status: 'unpriced', reason: 'no-schedule' }),
      entry('SECRET-4', 'deepseek-official', 'deepseek-flash', { status: 'priced', amountMicros: 1 }),
    ],
  }))

  const { stdout } = await runRescue(['meter'], { DSH_HOME: dir })
  const report = JSON.parse(stdout)
  assert.deepEqual(
    report.ledger.unpricedModels,
    [{ provider: 'deepseek-official', model: 'deepseek-v5', calls: 2, reason: 'unknown-model' }],
    'the report names the models with no rate, most used first',
  )
  assert.equal(stdout.includes('SECRET'), false, 'a model name is reported, never a call or a session')
})

test('rescue meter reports a fresh home as absent', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-openai-subscription-rescue-'))
  dirs.push(dir)
  const { stdout } = await runRescue(['meter'], { DSH_HOME: dir })
  const report = JSON.parse(stdout)
  assert.equal(report.ledger.present, false)
  assert.equal(report.settings.present, false)
  assert.equal(report.retiredCostMeterLedger.present, false)
})

test('rescue meter reports a corrupt ledger as unreadable', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-openai-subscription-rescue-'))
  dirs.push(dir)
  const ledgerDir = join(dir, 'storages', 'openai-subscription-meter')
  await mkdir(ledgerDir, { recursive: true })
  await writeFile(join(ledgerDir, 'usage.json'), '{ not json')
  const { stdout } = await runRescue(['meter'], { DSH_HOME: dir })
  const report = JSON.parse(stdout)
  assert.equal(report.ledger.present, true)
  assert.equal(report.ledger.unreadable, true)
})

test('rescue doctor flags a placeholder left before an appended entry', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-openai-subscription-profile-'))
  dirs.push(dir)
  const packagePath = join(dir, 'package.json')
  await writeFile(packagePath, JSON.stringify({ dependencies: {} }))
  await writeFile(join(dir, 'cordis.patch.yml'), [
    '# Your patch layer for this dsh profile',
    '[]',
    '',
    '- id: llm-openai-subscription',
    '  config:',
    '    state: active',
    '',
  ].join('\n'))
  const { stdout } = await runRescue(['doctor', '--profile', packagePath], {})
  const report = JSON.parse(stdout)
  assert.equal(report.profilePatchFile, true)
  assert.equal(report.profilePatchPlaceholderAppended, true)
  assert.match(report.profilePatchProblem, /will not compose/)
})

test('rescue doctor accepts a replaced placeholder and reports activation', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-openai-subscription-profile-'))
  dirs.push(dir)
  const packagePath = join(dir, 'package.json')
  await writeFile(packagePath, JSON.stringify({ dependencies: {} }))
  await writeFile(join(dir, 'cordis.patch.yml'), [
    '- id: llm-openai-subscription',
    '  config:',
    '    state: active',
    '',
  ].join('\n'))
  const { stdout } = await runRescue(['doctor', '--profile', packagePath], {})
  const report = JSON.parse(stdout)
  assert.equal(report.profilePatchPlaceholderAppended, false)
  assert.equal(report.profilePatchActivatesRow, true)
})

test('rescue doctor treats the shipped placeholder as unremarkable', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-openai-subscription-profile-'))
  dirs.push(dir)
  const packagePath = join(dir, 'package.json')
  await writeFile(packagePath, JSON.stringify({ dependencies: {} }))
  await writeFile(join(dir, 'cordis.patch.yml'), '# header\n[]\n')
  const { stdout } = await runRescue(['doctor', '--profile', packagePath], {})
  const report = JSON.parse(stdout)
  assert.equal(report.profilePatchFile, true)
  assert.equal(report.profilePatchPlaceholderAppended, false)
  assert.equal(report.profilePatchActivatesRow, false)
})

/**
 * Build the smallest archive a packaged Desktop install ships: a 16-byte pickle
 * header, the JSON directory padded to a four-byte boundary, then the payloads.
 *
 * The padding is the point of the fixture. A reader that adds the raw JSON
 * length to 16 lands two or three bytes early and parses garbage, which is
 * exactly the mistake this test exists to catch.
 * @param {Array<{path: string, content: string}>} entries
 * @returns {{archive: Buffer, headerLength: number}}
 */
function buildAsar(entries) {
  const tree = {}
  const payloads = []
  let offset = 0
  for (const entry of entries) {
    const content = Buffer.from(entry.content, 'utf8')
    const parts = entry.path.split('/')
    let node = tree
    for (const part of parts.slice(0, -1)) {
      if (node[part] === undefined) node[part] = { files: {} }
      node = node[part]
    }
    node.files[parts.at(-1)] = { size: content.length, offset }
    offset += content.length
    payloads.push(content)
  }
  // Trailing whitespace keeps the JSON valid while making the header length
  // deliberately unaligned, so the padding cannot be skipped.
  let json = JSON.stringify({ files: tree })
  while (json.length % 4 === 0) json += ' '
  const padded = Buffer.alloc(Math.ceil(json.length / 4) * 4)
  Buffer.from(json, 'utf8').copy(padded)
  const head = Buffer.alloc(16)
  head.writeUInt32LE(4, 0)
  head.writeUInt32LE(8 + padded.length, 4)
  head.writeUInt32LE(Buffer.byteLength(json), 12)
  return { archive: Buffer.concat([head, padded, ...payloads]), headerLength: Buffer.byteLength(json) }
}

test('rescue doctor reads the DSH version out of a packaged install app.asar', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-openai-subscription-home-'))
  dirs.push(dir)
  const runtime = JSON.stringify({
    schemaVersion: 1,
    release: { version: '0.1.7-rc.2', nodeVersion: '24.18.1', pnpmVersion: '11.7.0' },
  })
  const { archive, headerLength } = buildAsar([{ path: 'dsh/desktop-runtime.json', content: runtime }])
  assert.notEqual(headerLength % 4, 0, 'the fixture must exercise the header padding')
  await mkdir(join(dir, 'resources'), { recursive: true })
  await writeFile(join(dir, 'resources', 'app.asar'), archive)

  const profileDir = await mkdtemp(join(tmpdir(), 'dsh-openai-subscription-profile-'))
  dirs.push(profileDir)
  const packagePath = join(profileDir, 'package.json')
  await writeFile(packagePath, JSON.stringify({ dependencies: {} }))

  const { stdout } = await runRescue(['doctor', '--profile', packagePath], { DSH_HOME: dir })
  const report = JSON.parse(stdout)
  assert.equal(report.compatibility.installedDsh, '0.1.7-rc.2')
  assert.equal(report.compatibility.declaredDshRange, '>=0.1.6-alpha.1')
  assert.equal(report.compatibility.satisfied, true)
})

test('rescue doctor reports an unknown version rather than a wrong one', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-openai-subscription-home-'))
  dirs.push(dir)
  const profileDir = await mkdtemp(join(tmpdir(), 'dsh-openai-subscription-profile-'))
  dirs.push(profileDir)
  const packagePath = join(profileDir, 'package.json')
  await writeFile(packagePath, JSON.stringify({ dependencies: {} }))

  const { stdout } = await runRescue(['doctor', '--profile', packagePath], { DSH_HOME: dir })
  const report = JSON.parse(stdout)
  assert.equal(report.compatibility.installedDsh, null)
  // "unknown" must never read as "satisfied".
  assert.equal(report.compatibility.satisfied, null)
})

test('unknown command exits non-zero', async () => {
  await assert.rejects(runRescue(['wat'], {}), (error) => error.code === 2)
})
