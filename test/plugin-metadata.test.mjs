import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, readdir, rm, symlink } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { tmpdir } from 'node:os'

/**
 * The plugin page reads its card text from `locale/<language>.json`, not from
 * the manifest: DSH's `readPluginMeta` looks for exactly that directory and
 * projects `meta.title` / `meta.description` as a language map the client
 * resolves with the active locale. Without it the card falls back to the
 * English manifest one-liner, which is how a bilingual plugin still showed
 * English on the very page a person opens to look at it.
 *
 * The manifest description is therefore not the display text — it stays the
 * English fallback and the npm one-liner — and these tests keep both halves in
 * place: the directory the harness reads, and the published file list that has
 * to carry it.
 */

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

/** Every language file the harness would discover, keyed by language id. */
async function dictionaries() {
  const names = (await readdir(join(root, 'locale'))).filter((name) => name.endsWith('.json')).sort()
  const entries = await Promise.all(names.map(async (name) => [
    name.slice(0, -5),
    JSON.parse(await readFile(join(root, 'locale', name), 'utf8')),
  ]))
  return new Map(entries)
}

test('the card text exists for every language the harness can ask for', async () => {
  const found = await dictionaries()
  assert.deepEqual([...found.keys()].sort(), ['en', 'zh'], 'en and zh are the languages this plugin speaks')
  for (const [language, parsed] of found) {
    assert.equal(typeof parsed.meta?.title, 'string', `${language}: meta.title is what the card shows`)
    assert.ok(parsed.meta.title.length > 0, `${language}: an empty title falls back to the package name`)
    assert.equal(typeof parsed.meta?.description, 'string', `${language}: meta.description is the card's sentence`)
    assert.ok(parsed.meta.description.length > 0, `${language}: an empty description is dropped`)
  }
  // A translation that never got translated is the bug this file exists for.
  const enTitle = found.get('en').meta.title
  const zhTitle = found.get('zh').meta.title
  assert.notEqual(enTitle, zhTitle, 'the Chinese title must actually be Chinese')
  assert.match(zhTitle, /[\u4e00-\u9fff]/u, 'the Chinese title must contain Chinese')
  assert.match(found.get('zh').meta.description, /[\u4e00-\u9fff]/u, 'the Chinese description must contain Chinese')
})

test('the manifest keeps an English one-liner as the fallback', async () => {
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
  assert.ok(typeof manifest.description === 'string' && manifest.description.length > 0)
  // readPluginMeta falls back to this when a language file is missing.
  assert.match(manifest.description, /^[\x00-\x7F]+$/, 'the manifest description stays English')
  assert.equal(manifest.icon, './icon.svg')
})

test('the published file list carries the metadata the page needs', async () => {
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
  assert.ok(manifest.files.includes('locale/*.json'), 'a publish without locale/ loses the card text')
  assert.ok(manifest.files.includes('icon.svg'), 'a publish without the icon loses the artwork')
})

test('the exports map lets the harness reach the locale files', async () => {
  // This is the bug the card showed for a whole round: an `exports` map that
  // does not name `./locale/*.json` makes Node answer
  // ERR_PACKAGE_PATH_NOT_EXPORTED, the harness reads that as "no metadata", and
  // the card falls back to the English manifest line even in a Chinese UI.
  // Resolution is proven through a real node_modules link, not by looking for a
  // string in the manifest.
  const scratch = await mkdtemp(join(tmpdir(), 'plugin-metadata-'))
  try {
    await mkdir(join(scratch, 'node_modules'), { recursive: true })
    await symlink(root, join(scratch, 'node_modules', 'dsh-provider-openai-subscription'), 'junction')
    const resolve = createRequire(pathToFileURL(join(scratch, 'noop.js')).href).resolve
    for (const specifier of ['dsh-provider-openai-subscription/locale/en.json', 'dsh-provider-openai-subscription/locale/zh.json']) {
      assert.ok(resolve(specifier).endsWith('.json'), `${specifier} must resolve for the harness to read it`)
    }
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
})

test('the icon is a small manifest-relative image the harness accepts', async () => {
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
  const bytes = await readFile(join(root, manifest.icon.replace(/^\.\//, '')))
  // DSH accepts SVG/PNG/JPEG/WebP up to 256 KiB, contained in the manifest dir.
  assert.ok(bytes.length > 0 && bytes.length <= 256 * 1024, `icon is ${String(bytes.length)} bytes`)
  assert.match(bytes.toString('utf8').slice(0, 200), /<svg[\s>]/)
})
