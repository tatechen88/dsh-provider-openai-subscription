/**
 * Headless stdout discipline.
 *
 * `dsh --profile headless --json` writes newline-delimited JSON run events to
 * stdout, and stdout is the machine-readable channel: anything else written
 * there corrupts the stream for whatever is parsing it. The app already routes
 * its own progress to stderr, so the plugin's share of the contract is simply
 * never to write to stdout while it is loaded inside DSH.
 *
 * This is checked at the source because the failure would be invisible in a
 * normal run — it only breaks an automated consumer, and only when the printing
 * branch happens to execute.
 *
 * The rescue CLI is excluded on purpose: it is a standalone process that prints
 * its report to stdout and is never loaded inside DSH.
 *
 * @module dsh-provider-openai-subscription/test/headless-stdout
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

/** Files allowed to write to stdout, with the reason each one is safe. */
const ALLOWED = new Map([
  ['src/rescue.mjs', 'standalone CLI process; never loaded into DSH'],
])

/** Every `.js`/`.mjs` file under one directory, depth first. */
async function walk(directory, found = []) {
  let entries
  try {
    entries = await readdir(directory, { withFileTypes: true })
  } catch {
    return found
  }
  for (const entry of entries) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) await walk(path, found)
    else if (/\.(js|mjs)$/.test(entry.name)) found.push(path)
  }
  return found
}

test('no module DSH loads writes to stdout', async () => {
  const files = [
    ...(await walk(join(root, 'src'))),
    join(root, 'client', 'client.js'),
  ]
  const offenders = []
  for (const file of files) {
    const name = relative(root, file).split('\\').join('/')
    if (ALLOWED.has(name)) continue
    const source = await readFile(file, 'utf8')
    if (/process\.stdout/.test(source) || /console\.(log|info|warn|error|debug)\s*\(/.test(source)) {
      offenders.push(name)
    }
  }
  assert.deepEqual(offenders, [], 'a headless --json consumer parses stdout, so nothing else may write there')
})

test('the exempt file really is the standalone CLI', async () => {
  // Guards the exemption itself: if the rescue CLI ever becomes loadable inside
  // the plugin, this allowlist must be revisited rather than silently widening.
  const rescue = await readFile(join(root, 'src', 'rescue.mjs'), 'utf8')
  assert.match(rescue, /process\.stdout\.write/, 'the exemption exists because the CLI prints its report')
  assert.equal(/from '\.\/runtime\.js'/.test(rescue), false, 'the CLI must not import the plugin runtime')
})
