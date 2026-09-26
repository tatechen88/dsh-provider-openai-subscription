import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * The package ships a host half and nothing else.
 *
 * This is not a style rule. In DSH 0.1.7 a client entry that fails to import is
 * a *fatal* web-boot failure — `web boot: 1 entry did not activate` — which the
 * Desktop shell answers by reporting a crash and relaunching. The whole point of
 * this rebuild is that the path cannot exist, so the declaration that creates it
 * must never come back: not in the manifest, not in the exports map, not in the
 * published files, and not as a bundle on disk.
 *
 * @module dsh-provider-openai-subscription/test/no-client
 */

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

/** Read and parse the package manifest. */
async function manifest() {
  return JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
}

test('the manifest declares no browser half', async () => {
  const pkg = await manifest()
  assert.equal('client' in (pkg.dsh ?? {}), false, 'dsh.client would make the harness compose a browser entry')
  assert.equal('./client' in (pkg.exports ?? {}), false, 'the client entry point must not be exported')
  assert.equal((pkg.files ?? []).includes('client'), false, 'a publish must not carry a client directory')
  assert.equal(pkg.dsh?.bundle?.patch, './cordis.patch.yml', 'the host bundle patch is what the package still ships')
})

test('no client directory exists', async () => {
  const entries = await readdir(root).catch(() => [])
  assert.equal(entries.includes('client'), false, 'the client directory was removed and must not return')
})

test('no first-party module registers itself with the browser module loader', async () => {
  // `__ModuleLoader__.load` is the client-module handshake: seeing it in this
  // repository means a browser half came back under another name.
  const offenders = []
  const walk = async (directory) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) {
        await walk(path)
        continue
      }
      if (!/\.(js|mjs)$/.test(entry.name)) continue
      const source = await readFile(path, 'utf8')
      if (source.includes('__ModuleLoader__')) offenders.push(path.slice(root.length + 1))
    }
  }
  await walk(join(root, 'src'))
  await walk(join(root, 'scripts'))
  assert.deepEqual(offenders, [], 'these files talk to the browser module loader')
})
