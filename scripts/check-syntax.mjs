#!/usr/bin/env node
/**
 * Syntax-check every first-party source file.
 *
 * The check used to be a hand-maintained `node --check` list in package.json, and
 * every new source file had to be remembered there — the one step that silently
 * stopped running the day somebody forgot. Walking the tree removes that step.
 *
 * Files are checked with `node --check`, which parses without executing, exactly
 * as the previous list did.
 *
 * @module dsh-provider-openai-subscription/scripts/check-syntax
 */

import { readdir } from 'node:fs/promises'
import { join, relative, dirname } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
/** Directories walked for first-party code; node_modules never appears under them. */
const WALK_ROOTS = ['src', 'client', 'scripts', 'test']
const EXTENSIONS = new Set(['.js', '.mjs'])

/** Collect every .js/.mjs file under one directory, depth first. */
async function walk(directory, out) {
  let names
  try {
    names = await readdir(directory, { withFileTypes: true })
  } catch {
    // A directory that does not exist yet means nothing to check under it.
    return
  }
  for (const name of names) {
    const path = join(directory, name.name)
    if (name.isDirectory()) await walk(path, out)
    else if (EXTENSIONS.has(name.name.slice(name.name.lastIndexOf('.')))) out.push(path)
  }
}

const files = []
for (const walkRoot of WALK_ROOTS) await walk(join(root, walkRoot), files)
files.sort()

const failures = []
for (const file of files) {
  // The syntax check must not execute the file, which is why this is
  // `node --check` rather than an import.
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' })
  if (result.status !== 0) {
    failures.push({ file: relative(root, file), output: result.stderr || result.stdout })
  }
}

for (const failure of failures) {
  console.error(`✖ ${failure.file}`)
  console.error(failure.output)
}

console.log(`checked ${files.length} files, ${failures.length} failed`)
process.exitCode = failures.length === 0 ? 0 : 1
