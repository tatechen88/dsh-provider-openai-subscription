#!/usr/bin/env node
/**
 * Real DSH Web smoke: the page the harness serves carries no half of this plugin.
 *
 * This package is a host-only bundle. The one thing that made it fatal in a
 * browser surface is gone, and that absence must stay gone: a client entry that
 * fails to import is a *fatal* web-boot failure in DSH 0.1.7 (`web boot: 1 entry
 * did not activate`), which the Desktop shell answers with a crash and a
 * relaunch. So this check boots the genuine `dsh web` app against a throwaway
 * profile with the plugin installed and switched on, and asserts two things:
 *
 *   1. the served index mentions this package nowhere — no `dsh.client`
 *      declaration, no preload, no bundle row;
 *   2. the host half really activated, proven from the server side by the
 *      plugin's own route answering 401 (mounted, refused by the connection
 *      fence) instead of 404.
 *
 * Everything happens in a temporary DSH home: the profile, its module links,
 * and every session file are written there and removed at the end. The real
 * installation is only read, never written — `profiles/node_modules` is
 * borrowed through a junction, exactly as the headless smoke does it.
 *
 * Needs `DSH_HOME` pointing at an installed harness; without it the script
 * reports SKIP and exits zero. Pass `--require-dsh` (or set
 * DSH_REQUIRE_WEB=1) to make that a failure. Pass `--keep` to leave the
 * temporary home in place for inspection.
 *
 * @module dsh-provider-openai-subscription/scripts/web-smoke
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PACKAGE_NAME } from '../src/constants.js'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')

/** Release mode: a skipped check is a failed check. */
const REQUIRE_DSH = process.argv.includes('--require-dsh') || process.env.DSH_REQUIRE_WEB === '1'
const keep = process.argv.includes('--keep')

/** How long the app may take to print its URL before the check gives up. */
const READY_TIMEOUT_MS = 120_000

/** Report a check that could not run. */
function skip(message) {
  if (REQUIRE_DSH) {
    console.error(`FAIL: ${message} (--require-dsh refuses to skip)`)
    process.exit(1)
  }
  console.log(`SKIP: ${message}`)
  process.exit(0)
}

function fail(message) {
  console.error(`FAIL: ${message}`)
  process.exitCode = 1
}

function ok(message) {
  console.log(`OK: ${message}`)
}

const realHome = process.env.DSH_HOME
if (realHome === undefined || realHome.length === 0) {
  skip('DSH_HOME is not set, so there is no installed harness to borrow')
}
const realModules = join(realHome, 'profiles', 'node_modules')
// The launcher package is what a profile resolves `@deepseek-ai/dsh` to, so the
// check runs that exact installation's own CLI entry rather than PATH's `dsh`.
const cliEntry = join(realModules, '@deepseek-ai', 'dsh', 'lib', 'bin.js')
if (!existsSync(cliEntry)) {
  skip(`no installed harness under ${realModules}`)
}
const installedVersion = JSON.parse(await readFile(join(realModules, '@deepseek-ai', 'dsh', 'package.json'), 'utf8')).version

const home = await mkdtemp(join(tmpdir(), 'dsh-openai-subscription-web-'))
const profile = 'web-smoke'
const profileDir = join(home, 'profiles', profile)
/** The plugin is installed into the profile by name, the way a real install is. */
const linkPath = join(profileDir, 'node_modules', PACKAGE_NAME)

/**
 * Stop one child and wait for it to be gone, so its temporary home can be
 * removed without racing an open file handle.
 * @param {import('node:child_process').ChildProcess} child
 * @returns {Promise<void>}
 */
async function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return
  const exited = new Promise((settle) => child.once('exit', () => settle(undefined)))
  child.kill()
  const timedOut = await Promise.race([
    exited.then(() => false),
    new Promise((settle) => { setTimeout(() => settle(true), 8_000) }),
  ])
  if (timedOut) {
    child.kill('SIGKILL')
    await exited
  }
}

/**
 * Boot the web app and resolve once it prints the URL a browser would open.
 * @param {import('node:child_process').ChildProcess} child
 * @returns {Promise<string>}
 */
function waitForUrl(child) {
  return new Promise((settle, reject) => {
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      reject(new Error(`the web app printed no URL within ${String(READY_TIMEOUT_MS)}ms; stderr: ${stderr.trim().split('\n').slice(-4).join(' | ')}`))
    }, READY_TIMEOUT_MS)
    const finish = (error, url) => {
      clearTimeout(timer)
      child.stdout.off('data', onData)
      child.stderr.off('data', onError)
      child.off('exit', onExit)
      if (error !== undefined) reject(error)
      else settle(url)
    }
    const onData = (chunk) => {
      stdout += String(chunk)
      const match = /(http:\/\/127\.0\.0\.1:\d+\/\?token=\S+)/.exec(stdout)
      if (match !== null) finish(undefined, match[1])
    }
    const onError = (chunk) => { stderr += String(chunk) }
    const onExit = (code) => {
      finish(new Error(`the web app exited ${String(code)} before serving; stderr: ${stderr.trim().split('\n').slice(-4).join(' | ')}`))
    }
    child.stdout.on('data', onData)
    child.stderr.on('data', onError)
    child.once('exit', onExit)
  })
}

/**
 * Reserve a free port for this run.
 *
 * `--port 0` lands on the profile's configured port rather than an
 * OS-assigned one, which would collide with a real `dsh web` already running.
 * Asking the OS for a free port and handing that number over keeps the check
 * runnable beside a live deployment.
 * @returns {Promise<number>}
 */
function pickPort() {
  return new Promise((settle, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      server.close(() => settle(address.port))
    })
  })
}

/**
 * Fetch one URL the way a browser that follows the harness's own redirect
 * would: the token query is exchanged for a session cookie, and a plain fetch
 * has no cookie jar of its own.
 * @param {string} target
 * @returns {Promise<{response: Response, text: string, cookies: string}>}
 */
async function fetchWithSession(target) {
  const first = await fetch(target, { redirect: 'manual' })
  const cookies = first.headers.getSetCookie().map((entry) => entry.split(';')[0]).join('; ')
  if (first.status < 300 || first.status >= 400) {
    return { response: first, text: await first.text(), cookies }
  }
  const location = first.headers.get('location') ?? target
  const response = await fetch(new URL(location, target).href, {
    headers: cookies.length === 0 ? {} : { cookie: cookies },
  })
  return { response, text: await response.text(), cookies }
}

let child
try {
  await mkdir(profileDir, { recursive: true })
  await symlink(realModules, join(home, 'profiles', 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir')
  // The plugin lives in the profile's own node_modules, which is where an
  // installed package resolves from — and what the client scan reads a
  // manifest out of.
  await mkdir(dirname(linkPath), { recursive: true })
  await symlink(root, linkPath, process.platform === 'win32' ? 'junction' : 'dir')

  await writeFile(join(profileDir, 'package.json'), JSON.stringify({
    name: `dsh-profile-${profile}`,
    private: true,
    dependencies: {},
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'], patchReload: 'startup' } },
  }, null, 2))

  // Active on purpose: the point is that a real, switched-on host entry leaves
  // no trace in the page while still mounting its own routes server-side.
  await writeFile(join(profileDir, 'cordis.patch.yml'), [
    '# Generated by scripts/web-smoke.mjs; not a shipped composition.',
    '- insert:',
    `    - id: llm-openai-subscription`,
    `      name: ${PACKAGE_NAME}`,
    '      config:',
    '        state: active',
    '        oauth:',
    '          clientId: web-smoke',
    '',
  ].join('\n'))

  console.log(`temp DSH home: ${home}`)
  console.log(`dsh ${installedVersion} (${cliEntry})`)

  const port = await pickPort()
  child = spawn(process.execPath, [
    cliEntry,
    '--profile', profile,
    '--no-open',
    '--port', String(port),
  ], {
    cwd: root,
    env: { ...process.env, DSH_HOME: home },
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  const url = await waitForUrl(child)
  ok(`the web app serves on port ${new URL(url).port}`)

  const { response: indexResponse, text: index, cookies } = await fetchWithSession(url)
  if (indexResponse.status !== 200) {
    fail(`the index answered HTTP ${String(indexResponse.status)}`)
  } else if (index.includes(PACKAGE_NAME)) {
    fail('the served index mentions this package: it must ship no browser half at all')
  } else if (/plugins\/\?\?[^"']*dsh-provider-openai-subscription/.test(index.replaceAll('&amp;', '&'))) {
    fail('the served index preloads a bundle of this plugin')
  } else {
    ok('the served index carries no trace of this package')
  }

  // The host half, checked from the server side and without a browser session:
  // the plugin's own route is mounted and refuses an anonymous caller (401),
  // while a path no plugin claims answers something else. That pair is the only
  // proof of activation that needs no browser.
  const servedPort = new URL(url).port
  const statusProbe = await fetch(`http://127.0.0.1:${servedPort}/plugins/openai-subscription/status`)
  const missingProbe = await fetch(`http://127.0.0.1:${servedPort}/plugins/openai-subscription-not-mounted/status`)
  if (statusProbe.status !== 401) {
    fail(`the plugin's own route answered ${String(statusProbe.status)} instead of the fence's 401`)
  } else if (missingProbe.status === 401) {
    fail('a path no plugin claims also answered 401, so the probe proves nothing')
  } else {
    ok(`the host half is mounted (401 on its own route, ${String(missingProbe.status)} on an unclaimed one)`)
  }
} finally {
  if (child !== undefined) await stop(child)
  if (keep) console.log(`kept: ${home}`)
  else await rm(home, { recursive: true, force: true })
}

if (process.exitCode === undefined || process.exitCode === 0) {
  console.log('web smoke: PASS')
} else {
  console.log('web smoke: FAIL')
}
