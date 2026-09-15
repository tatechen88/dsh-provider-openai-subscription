/**
 * Real DeepSeek balance check.
 *
 * Runs only when a key is actually available, and skips otherwise, because the
 * endpoint under test is the provider's own and the assertion is about the real
 * response, not a fixture. Run it deliberately:
 *
 *   DEEPSEEK_API_KEY=... node --test test/usage-deepseek-balance.e2e.mjs
 *   node --test test/usage-deepseek-balance.e2e.mjs          # reads $DSH_HOME/.env
 *
 * The account's own numbers are never printed; only their shape is asserted.
 *
 * @module dsh-provider-openai-subscription/test/usage-deepseek-balance-e2e
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { fetchDeepSeekBalance } from '../src/usage/deepseek-balance.js'

/**
 * Resolve a key from the environment or the DSH home's `.env`.
 * @returns {string|undefined}
 */
function apiKey() {
  if (typeof process.env.DEEPSEEK_API_KEY === 'string' && process.env.DEEPSEEK_API_KEY.length > 0) {
    return process.env.DEEPSEEK_API_KEY
  }
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  for (const candidate of [join(home, '.env'), join(home, '..', '.env')]) {
    try {
      const line = readFileSync(candidate, 'utf8')
        .split(/\r?\n/)
        .find((entry) => entry.startsWith('DEEPSEEK_API_KEY='))
      if (line === undefined) continue
      const value = line.slice('DEEPSEEK_API_KEY='.length).trim().replace(/^["']|["']$/g, '')
      if (value.length > 0) return value
    } catch {
      // The next candidate may still hold the key.
    }
  }
  return undefined
}

const key = apiKey()

test('the official balance endpoint answers the shape this plugin parses', { skip: key === undefined ? 'no DEEPSEEK_API_KEY available' : false }, async () => {
  const snapshot = await fetchDeepSeekBalance({
    baseURL: 'https://api.deepseek.com',
    apiKey: key,
  })
  assert.equal(typeof snapshot.available, 'boolean', 'is_available is a boolean')
  assert.ok(Array.isArray(snapshot.infos), 'balance_infos is an array')
  assert.ok(snapshot.infos.length > 0, 'the account reports at least one currency row')
  for (const info of snapshot.infos) {
    assert.equal(typeof info.currency, 'string')
    assert.ok(info.currency.length >= 3, 'each row names its currency')
    assert.ok(Number.isFinite(info.total), 'total_balance parsed to a finite number')
    assert.ok(Number.isFinite(info.granted), 'granted_balance parsed to a finite number')
    assert.ok(Number.isFinite(info.toppedUp), 'topped_up_balance parsed to a finite number')
    assert.ok(info.total >= 0 && info.granted >= 0 && info.toppedUp >= 0)
    // The documented invariant: total is granted plus topped-up.
    assert.ok(
      Math.abs(info.total - (info.granted + info.toppedUp)) < 0.011,
      `total_balance should equal granted_balance + topped_up_balance for ${info.currency}`,
    )
  }
  assert.ok(snapshot.primary !== undefined, 'a primary row is resolvable from the real response')
  assert.ok(Number.isFinite(snapshot.fetchedAt) && snapshot.fetchedAt > 0, 'the reading is timestamped')
  // The account's own numbers stay out of the log on purpose.
  console.log(`OK: ${snapshot.infos.length} currency row(s); primary=${snapshot.primary.currency}; available=${String(snapshot.available)}`)
})
