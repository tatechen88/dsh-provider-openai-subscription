#!/usr/bin/env node
/**
 * End-to-end check of the documented installation path.
 *
 * It reproduces the README steps inside a throwaway DSH home: initialize a
 * profile from the shipped web template, install this package with the
 * documented `dsh plugin ... add` command, then compose the profile twice and
 * assert the plugin row arrives in its inactive default state and reaches
 * `state: active` once the activation entry replaces the shipped placeholder.
 *
 * The check needs `dsh` and `pnpm` on PATH; without them it reports SKIP and
 * exits zero. Pass `--keep` to leave the temporary home in place for
 * inspection. Pass `--require-tools` (or set DSH_REQUIRE_INSTALL=1) for a
 * release check, where a missing tool is a failure rather than a skip.
 *
 * @module dsh-provider-openai-subscription/scripts/install-smoke
 */

import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const keep = process.argv.includes('--keep')
const profile = 'install-smoke'

/** Release mode: a skipped check is a failed check. */
const REQUIRE_TOOLS = process.argv.includes('--require-tools') || process.env.DSH_REQUIRE_INSTALL === '1'

/** The install command is documented as a CLI call, so the smoke test uses one. */
function cli(command, env) {
  return spawnSync(command, { shell: true, encoding: 'utf8', env, cwd: root })
}

/** Quote one argument for the shell that runs the documented commands. */
function quoted(value) {
  return /\s/.test(value) ? `"${value}"` : value
}

function ok(message) {
  process.stdout.write(`OK: ${message}\n`)
}

function fail(message) {
  process.stderr.write(`FAIL: ${message}\n`)
  process.exitCode = 1
}

const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
const packageName = manifest.name

for (const tool of ['dsh', 'pnpm']) {
  const probe = cli(`${tool} --version`, process.env)
  if (probe.error !== undefined || probe.status !== 0) {
    if (REQUIRE_TOOLS) {
      process.stderr.write(`FAIL: ${tool} is not available on PATH (--require-tools refuses to skip)\n`)
      process.exit(1)
    }
    process.stdout.write(`SKIP: ${tool} is not available on PATH\n`)
    process.exit(0)
  }
}

const home = await mkdtemp(join(tmpdir(), 'dsh-install-smoke-'))
const env = { ...process.env, DSH_HOME: home }
process.stdout.write(`temp DSH home: ${home}\n`)

try {
  const init = cli(`dsh --profile ${profile} --from-default-profile web --dump-config`, env)
  if (init.status !== 0) fail(`profile initialization exited ${String(init.status)}: ${init.stderr.trim()}`)
  else ok('a profile initializes from the shipped web template')

  const add = cli(`dsh plugin --profile ${profile} add ${quoted(root)}`, env)
  if (add.status !== 0) fail(`install exited ${String(add.status)}: ${add.stderr.trim()}`)
  else ok('the documented install command exits zero')

  const profileDir = join(home, 'profiles', profile)
  const installed = JSON.parse(await readFile(join(profileDir, 'package.json'), 'utf8'))
  if (installed.dependencies?.[packageName] === undefined) fail('the dependency was not added')
  else ok(`dependency added: ${String(installed.dependencies[packageName])}`)
  if (installed.dsh?.profile?.bundles?.includes(packageName) !== true) {
    fail('the bundle list does not include the plugin, so its patch layer would never apply')
  } else ok('bundle list updated without a manual edit')

  const inactive = cli(`dsh --profile ${profile} --dump-config`, env)
  if (inactive.status !== 0) fail(`composition failed after install: ${inactive.stderr.trim()}`)
  else if (!inactive.stdout.includes('id: llm-openai-subscription')) fail('the composed tree has no plugin row')
  else if (!inactive.stdout.includes('state: bootstrap')) {
    fail('the row is not in its inactive bootstrap default')
  } else ok('row composes in state: bootstrap, so installing alone never loads the runtime')

  const patch = join(profileDir, 'cordis.patch.yml')
  const shipped = await readFile(patch, 'utf8')
  const activation = [
    '- id: llm-openai-subscription',
    '  config:',
    '    state: active',
    '    oauth:',
    '      clientId: install-smoke',
    '    provider:',
    "      defaultModel: ''",
    "      reasoningEffort: ''",
    '',
  ].join('\n')
  if (!shipped.includes('[]')) fail('the shipped activation layer has no placeholder to replace')
  else {
    // The placeholder is replaced, never appended to: `[]` followed by a block
    // sequence is invalid YAML and stops the profile from composing.
    await writeFile(patch, `# activation for install-smoke\n${activation}`, 'utf8')
    const active = cli(`dsh --profile ${profile} --dump-config`, env)
    if (active.status !== 0) fail(`composition failed after activation: ${active.stderr.trim()}`)
    else if (!active.stdout.includes('state: active')) fail('the row did not reach state: active')
    else ok('replacing the placeholder activates the row')
  }
} finally {
  if (keep) process.stdout.write(`kept: ${home}\n`)
  else await rm(home, { recursive: true, force: true })
}

process.stdout.write(process.exitCode === undefined || process.exitCode === 0 ? 'install smoke: PASS\n' : 'install smoke: FAIL\n')
