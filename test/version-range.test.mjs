/**
 * Precedence rules behind the readiness report's DSH compatibility verdict.
 *
 * The report tells a user whether the harness they installed is the one this
 * plugin's declared `engines.dsh` requires. A wrong verdict is worse than none —
 * it either sends somebody chasing a working install or hides a real mismatch —
 * so the prerelease rules are pinned directly rather than only through the CLI.
 *
 * @module dsh-provider-openai-subscription/test/version-range
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { compareVersions, parseVersion, satisfiesRange } from '../src/version-range.mjs'

/** Compare two spellings and report the ordering. */
function order(left, right) {
  return compareVersions(parseVersion(left), parseVersion(right))
}

test('parseVersion reads the forms an engines range can name', () => {
  assert.deepEqual(parseVersion('0.1.6'), { numbers: [0, 1, 6], prerelease: [] })
  assert.deepEqual(parseVersion('v0.1.6-alpha.1'), { numbers: [0, 1, 6], prerelease: ['alpha', '1'] })
  assert.deepEqual(parseVersion('1.2.3+build.9'), { numbers: [1, 2, 3], prerelease: [] })
  assert.deepEqual(parseVersion(' 0.1.6-rc.2 '), { numbers: [0, 1, 6], prerelease: ['rc', '2'] })
  for (const bad of [undefined, null, '', 'latest', '0.1', '1.2.3.4', 7]) {
    assert.equal(parseVersion(bad), null, `${String(bad)} is not a version`)
  }
})

test('numeric fields compare numerically, not as text', () => {
  assert.equal(order('0.1.6', '0.1.10'), -1, '6 is below 10, though "6" sorts after "1"')
  assert.equal(order('0.2.0', '0.1.99'), 1)
  assert.equal(order('1.0.0', '1.0.0'), 0)
})

test('a prerelease sorts before its own release', () => {
  assert.equal(order('0.1.6-alpha.1', '0.1.6'), -1)
  assert.equal(order('0.1.7-alpha.1', '0.1.6'), 1, 'the numeric fields still decide first')
})

test('prerelease identifiers follow the semver ordering rules', () => {
  assert.equal(order('0.1.6-alpha.1', '0.1.6-alpha.2'), -1)
  assert.equal(order('0.1.6-alpha.10', '0.1.6-alpha.9'), 1, 'numeric identifiers compare as numbers')
  assert.equal(order('0.1.6-alpha', '0.1.6-alpha.1'), -1, 'a shorter equal prefix sorts first')
  assert.equal(order('0.1.6-1', '0.1.6-alpha'), -1, 'numeric identifiers rank below alphanumeric ones')
  assert.equal(order('0.1.6-rc.1', '0.1.6-beta.9'), 1, 'alphanumeric identifiers compare lexically')
})

test('satisfiesRange answers the declared engines form', () => {
  assert.equal(satisfiesRange('0.1.6-alpha.1', '>=0.1.6-alpha.1'), true)
  assert.equal(satisfiesRange('0.1.6', '>=0.1.6-alpha.1'), true, 'the release supersedes its prerelease')
  assert.equal(satisfiesRange('0.1.6-alpha.0', '>=0.1.6-alpha.1'), false)
  assert.equal(satisfiesRange('0.1.5-rc.2', '>=0.1.6-alpha.1'), false)
  assert.equal(satisfiesRange('0.2.0', '>=0.1.6-alpha.1'), true)
  assert.equal(satisfiesRange('0.1.6', '<0.2.0'), true)
  assert.equal(satisfiesRange('0.1.6', '=0.1.6'), true)
  assert.equal(satisfiesRange('0.1.7', '=0.1.6'), false)
})

test('every clause of a range has to hold', () => {
  assert.equal(satisfiesRange('0.1.6', '>=0.1.6 <0.2.0'), true)
  assert.equal(satisfiesRange('0.2.1', '>=0.1.6 <0.2.0'), false)
})

test('an unreadable side answers unknown rather than a mismatch', () => {
  assert.equal(satisfiesRange('not-a-version', '>=0.1.6'), null)
  assert.equal(satisfiesRange('0.1.6', 'not-a-range'), null)
  assert.equal(satisfiesRange('0.1.6', ''), null)
  assert.equal(satisfiesRange('0.1.6', undefined), null)
})
